import { GraphQLError } from 'graphql';
import type { PoolClient } from 'pg';
import type { Db } from './db.js';
import type { RedisClient } from './redis.js';
import { CANCELLABLE, NOTIFICATION_FOR, canTransition, type Status } from './stateMachine.js';
import { fault } from './faults.js';

export const fail = (code: string, message: string) => new GraphQLError(message, { extensions: { code } });

export interface OrderRow {
  id: string; user_id: number; status: Status; total_cents: number; created_at: Date; updated_at: Date; delivered_at: Date | null;
}

/** Runs `fn` in one database transaction. Everything it does is committed together, or none of it is. */
export async function withTx<T>(db: Db, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// ------------------------------------------------------------------ product cache (read-through, invalidated when stock changes)
const PRODUCT_TTL_SECONDS = 60;
export interface ProductRow { id: number; name: string; price_cents: number; stock: number }

export async function getProduct(db: Db, redis: RedisClient, id: number): Promise<ProductRow | null> {
  const cached = await redis.get(`product:${id}`);
  if (cached) return JSON.parse(cached) as ProductRow;
  const { rows } = await db.query<ProductRow>('select id, name, price_cents, stock from products where id = $1', [id]);
  if (!rows.length) return null;
  await redis.set(`product:${id}`, JSON.stringify(rows[0]), 'EX', PRODUCT_TTL_SECONDS);
  return rows[0];
}

export async function invalidateProducts(redis: RedisClient, ids: number[]): Promise<void> {
  if (ids.length) await redis.del(...ids.map((id) => `product:${id}`));
}

// ------------------------------------------------------------------ the one place where an order changes status
/**
 * Moves an order to `to`, inside the caller's transaction: checks the move is legal, records the event, creates the customer
 * notification and, when an order is cancelled, puts its stock back. The order row is locked first, so two things happening to the
 * same order at once (for example a cancellation and a payment webhook) are handled one after the other.
 */
export async function transition(client: PoolClient, orderId: string, to: Status, source: string, type = 'status_changed'): Promise<{ order: OrderRow; touchedProducts: number[] }> {
  const { rows } = await client.query<OrderRow>('select * from orders where id = $1 for update', [orderId]);
  if (!rows.length) throw fail('NOT_FOUND', 'Order not found');
  const from = rows[0].status;
  if (!canTransition(from, to)) throw fail('INVALID_TRANSITION', `An order cannot move from ${from} to ${to}`);

  const updated = await client.query<OrderRow>(
    `update orders set status = $2, updated_at = now(), delivered_at = case when $2 = 'DELIVERED' then now() else delivered_at end
     where id = $1 returning *`,
    [orderId, to],
  );
  await client.query('insert into order_events (order_id, type, from_status, to_status, source) values ($1, $2, $3, $4, $5)', [orderId, type, from, to, source]);
  const kind = NOTIFICATION_FOR[to];
  if (kind && !(fault('no-notification-on-ship') && kind === 'order_shipped')) await client.query('insert into notifications (user_id, order_id, kind) values ($1, $2, $3)', [rows[0].user_id, orderId, kind]);

  let touchedProducts: number[] = [];
  if (to === 'CANCELLED' && (CANCELLABLE.includes(from) || fault('cancel-after-ship')) && !fault('no-restock-on-cancel')) {
    const restocked = await client.query<{ id: number }>(
      `update products p set stock = p.stock + oi.quantity from order_items oi where oi.order_id = $1 and oi.product_id = p.id returning p.id`,
      [orderId],
    );
    touchedProducts = restocked.rows.map((r) => r.id);
  }
  return { order: updated.rows[0], touchedProducts };
}

// ------------------------------------------------------------------ cart (Redis) and checkout (PostgreSQL)
export const MAX_QUANTITY_PER_PRODUCT = 99;
export const CART_TTL_SECONDS = 3600;
export const cartKey = (userId: number) => `cart:${userId}`;

export async function readCart(redis: RedisClient, userId: number): Promise<Array<{ productId: number; quantity: number }>> {
  const raw = await redis.hgetall(cartKey(userId));
  return Object.entries(raw).map(([productId, quantity]) => ({ productId: Number(productId), quantity: Number(quantity) })).sort((a, b) => a.productId - b.productId);
}

export async function checkout(db: Db, redis: RedisClient, userId: number): Promise<OrderRow> {
  const cart = await readCart(redis, userId);
  if (!cart.length) throw fail('EMPTY_CART', 'The cart is empty');

  const order = await withTx(db, async (client) => {
    let total = 0;
    const lines: Array<{ productId: number; quantity: number; price: number }> = [];
    for (const item of cart) { // in product id order, so two checkouts that share products cannot deadlock
      const { rows } = await client.query<ProductRow>(`select id, price_cents, stock from products where id = $1${fault('no-row-lock') ? '' : ' for update'}`, [item.productId]);
      if (!rows.length) throw fail('NOT_FOUND', `Product ${item.productId} no longer exists`);
      if (rows[0].stock < item.quantity) throw fail('INSUFFICIENT_STOCK', `Only ${rows[0].stock} of product ${item.productId} left`);
      await client.query('update products set stock = stock - $2 where id = $1', [item.productId, item.quantity]);
      lines.push({ productId: item.productId, quantity: item.quantity, price: rows[0].price_cents });
      total += rows[0].price_cents * (fault('total-ignores-quantity') ? 1 : item.quantity);
    }
    const created = await client.query<OrderRow>('insert into orders (user_id, status, total_cents) values ($1, $2, $3) returning *', [userId, 'PENDING_PAYMENT', total]);
    for (const l of lines) await client.query('insert into order_items (order_id, product_id, quantity, unit_price_cents) values ($1, $2, $3, $4)', [created.rows[0].id, l.productId, l.quantity, l.price]);
    await client.query('insert into order_events (order_id, type, from_status, to_status, source) values ($1, $2, $3, $4, $5)', [created.rows[0].id, 'order_created', null, 'PENDING_PAYMENT', 'customer']);
    return created.rows[0];
  });

  await redis.del(cartKey(userId));
  if (!fault('stale-cache')) await invalidateProducts(redis, cart.map((c) => c.productId)); // the cached stock figures are now wrong
  return order;
}

export async function cancelOrder(db: Db, redis: RedisClient, orderId: string, source: string): Promise<OrderRow> {
  const { order, touchedProducts } = await withTx(db, (client) => transition(client, orderId, 'CANCELLED', source, 'order_cancelled'));
  await invalidateProducts(redis, touchedProducts);
  return order;
}

export async function requestReturn(db: Db, orderId: string, reason: string, windowDays: number): Promise<OrderRow> {
  return withTx(db, async (client) => {
    const { rows } = await client.query<OrderRow>('select * from orders where id = $1 for update', [orderId]);
    if (!rows.length) throw fail('NOT_FOUND', 'Order not found');
    if (rows[0].status === 'DELIVERED' && rows[0].delivered_at && !fault('no-return-window')) {
      const ageDays = (Date.now() - rows[0].delivered_at.getTime()) / 86_400_000;
      if (ageDays > windowDays) throw fail('RETURN_WINDOW_CLOSED', `Returns are accepted for ${windowDays} days after delivery`);
    }
    const { order } = await transition(client, orderId, 'RETURN_REQUESTED', 'customer', 'return_requested');
    await client.query('insert into returns (order_id, reason, status) values ($1, $2, $3)', [orderId, reason, 'REQUESTED']);
    return order;
  });
}

export async function completeReturn(db: Db, redis: RedisClient, orderId: string): Promise<OrderRow> {
  const result = await withTx(db, async (client) => {
    const { order } = await transition(client, orderId, 'RETURNED', 'warehouse', 'return_completed');
    await client.query("update returns set status = 'COMPLETED' where order_id = $1", [orderId]);
    const restocked = await client.query<{ id: number }>(
      'update products p set stock = p.stock + oi.quantity from order_items oi where oi.order_id = $1 and oi.product_id = p.id returning p.id', [orderId]);
    return { order, ids: restocked.rows.map((r) => r.id) };
  });
  await invalidateProducts(redis, result.ids);
  return result.order;
}

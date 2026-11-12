import DataLoader from 'dataloader';
import type { Db } from './db.js';
import type { Config } from './config.js';
import type { RedisClient } from './redis.js';
import { CART_TTL_SECONDS, MAX_QUANTITY_PER_PRODUCT, cancelOrder, cartKey, checkout, completeReturn, fail, getProduct, readCart, requestReturn, transition, withTx, type OrderRow, type ProductRow } from './orders.js';

export interface User { id: number; email: string }
interface ItemRow { order_id: string; product_id: number; quantity: number; unit_price_cents: number }
interface EventRow { order_id: string; type: string; from_status: string | null; to_status: string | null; source: string; created_at: Date }

export interface Context {
  db: Db;
  redis: RedisClient;
  config: Config;
  user: User | null;
  isAdmin: boolean;
  loaders: ReturnType<typeof createLoaders>;
}

/** One set of batching loaders per request: a list of 20 orders costs 3 queries, not 41 (no N+1). */
export function createLoaders(db: Db) {
  const group = <T extends { order_id: string }>(ids: readonly string[], rows: T[]) => ids.map((id) => rows.filter((r) => r.order_id === id));
  return {
    items: new DataLoader<string, ItemRow[]>(async (ids) => {
      const { rows } = await db.query<ItemRow>('select * from order_items where order_id = any($1::uuid[]) order by product_id', [ids]);
      return group(ids, rows);
    }),
    events: new DataLoader<string, EventRow[]>(async (ids) => {
      const { rows } = await db.query<EventRow>('select * from order_events where order_id = any($1::uuid[]) order by id', [ids]);
      return group(ids, rows);
    }),
    product: new DataLoader<number, ProductRow | null>(async (ids) => {
      const { rows } = await db.query<ProductRow>('select id, name, price_cents, stock from products where id = any($1::int[])', [ids]);
      const byId = new Map(rows.map((r) => [r.id, r]));
      return ids.map((id) => byId.get(id) ?? null);
    }),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUser(ctx: Context): User {
  if (!ctx.user) throw fail('UNAUTHENTICATED', 'Send a valid "Authorization: Bearer <token>" header');
  return ctx.user;
}
function requireAdmin(ctx: Context): void {
  if (!ctx.isAdmin) throw fail('FORBIDDEN', 'This operation needs the admin key');
}

/** At most `rateLimitPerMinute` mutations per user per minute, counted in Redis. */
async function rateLimit(ctx: Context, user: User): Promise<void> {
  const key = `rl:${user.id}:${Math.floor(Date.now() / 60_000)}`;
  const count = await ctx.redis.incr(key);
  if (count === 1) await ctx.redis.expire(key, 60);
  if (count > ctx.config.rateLimitPerMinute) throw fail('RATE_LIMITED', 'Too many requests, try again in a minute');
}

async function loadOwnedOrder(ctx: Context, id: string, user: User): Promise<OrderRow> {
  if (!UUID.test(id)) throw fail('NOT_FOUND', 'Order not found');
  const { rows } = await ctx.db.query<OrderRow>('select * from orders where id = $1', [id]);
  // someone else's order looks exactly like a missing one, so order ids cannot be probed
  if (!rows.length || (rows[0].user_id !== user.id && !ctx.isAdmin)) throw fail('NOT_FOUND', 'Order not found');
  return rows[0];
}

async function cartView(ctx: Context, user: User) {
  const lines = await readCart(ctx.redis, user.id);
  const items = [];
  let totalCents = 0;
  for (const l of lines) {
    const product = await getProduct(ctx.db, ctx.redis, l.productId);
    if (!product) continue;
    items.push({ product, quantity: l.quantity });
    totalCents += product.price_cents * l.quantity;
  }
  return { items, totalCents };
}

const intArg = (value: string, what: string): number => {
  if (!/^\d+$/.test(value)) throw fail('BAD_USER_INPUT', `${what} must be a whole number`);
  return Number(value);
};

export const resolvers = {
  Query: {
    products: async (_: unknown, args: { first: number; after?: string | null }, ctx: Context) => {
      if (args.first < 1 || args.first > 100) throw fail('BAD_USER_INPUT', '"first" must be between 1 and 100');
      const after = args.after ? intArg(args.after, 'after') : 0;
      const { rows } = await ctx.db.query<ProductRow>('select id, name, price_cents, stock from products where id > $1 order by id limit $2', [after, args.first + 1]);
      const items = rows.slice(0, args.first);
      return { items, nextCursor: rows.length > args.first ? items[items.length - 1].id : null };
    },
    product: (_: unknown, args: { id: string }, ctx: Context) => getProduct(ctx.db, ctx.redis, intArg(args.id, 'id')),
    me: (_: unknown, __: unknown, ctx: Context) => ctx.user,
    order: async (_: unknown, args: { id: string }, ctx: Context) => {
      const user = requireUser(ctx);
      try {
        return await loadOwnedOrder(ctx, args.id, user);
      } catch (err) {
        if ((err as { extensions?: { code?: string } }).extensions?.code === 'NOT_FOUND') return null; // unknown or someone else's: indistinguishable
        throw err;
      }
    },
    cart: (_: unknown, __: unknown, ctx: Context) => cartView(ctx, requireUser(ctx)),
    notifications: async (_: unknown, __: unknown, ctx: Context) => {
      const user = requireUser(ctx);
      const { rows } = await ctx.db.query('select kind, order_id, created_at from notifications where user_id = $1 order by id', [user.id]);
      return rows.map((r) => ({ kind: r.kind, orderId: r.order_id, createdAt: r.created_at.toISOString() }));
    },
  },

  Mutation: {
    addToCart: async (_: unknown, args: { productId: string; quantity: number }, ctx: Context) => {
      const user = requireUser(ctx);
      await rateLimit(ctx, user);
      if (!Number.isInteger(args.quantity) || args.quantity < 1) throw fail('BAD_USER_INPUT', 'quantity must be a positive whole number');
      const productId = intArg(args.productId, 'productId');
      if (!(await getProduct(ctx.db, ctx.redis, productId))) throw fail('NOT_FOUND', 'Product not found');
      const current = Number((await ctx.redis.hget(cartKey(user.id), String(productId))) ?? 0);
      if (current + args.quantity > MAX_QUANTITY_PER_PRODUCT) throw fail('BAD_USER_INPUT', `At most ${MAX_QUANTITY_PER_PRODUCT} of one product per order`);
      await ctx.redis.hset(cartKey(user.id), String(productId), String(current + args.quantity));
      await ctx.redis.expire(cartKey(user.id), CART_TTL_SECONDS);
      return cartView(ctx, user);
    },
    removeFromCart: async (_: unknown, args: { productId: string }, ctx: Context) => {
      const user = requireUser(ctx);
      await rateLimit(ctx, user);
      await ctx.redis.hdel(cartKey(user.id), String(intArg(args.productId, 'productId')));
      return cartView(ctx, user);
    },
    checkout: async (_: unknown, __: unknown, ctx: Context) => {
      const user = requireUser(ctx);
      await rateLimit(ctx, user);
      return checkout(ctx.db, ctx.redis, user.id);
    },
    cancelOrder: async (_: unknown, args: { orderId: string }, ctx: Context) => {
      const user = requireUser(ctx);
      await rateLimit(ctx, user);
      const order = await loadOwnedOrder(ctx, args.orderId, user);
      return cancelOrder(ctx.db, ctx.redis, order.id, ctx.isAdmin ? 'admin' : 'customer');
    },
    requestReturn: async (_: unknown, args: { orderId: string; reason: string }, ctx: Context) => {
      const user = requireUser(ctx);
      await rateLimit(ctx, user);
      if (!args.reason.trim()) throw fail('BAD_USER_INPUT', 'A reason is required');
      const order = await loadOwnedOrder(ctx, args.orderId, user);
      return requestReturn(ctx.db, order.id, args.reason.trim(), ctx.config.returnWindowDays);
    },
    markFulfilling: async (_: unknown, args: { orderId: string }, ctx: Context) => {
      requireAdmin(ctx);
      if (!UUID.test(args.orderId)) throw fail('NOT_FOUND', 'Order not found');
      return (await withTx(ctx.db, (client) => transition(client, args.orderId, 'FULFILLING', 'warehouse'))).order;
    },
    completeReturn: async (_: unknown, args: { orderId: string }, ctx: Context) => {
      requireAdmin(ctx);
      if (!UUID.test(args.orderId)) throw fail('NOT_FOUND', 'Order not found');
      return completeReturn(ctx.db, ctx.redis, args.orderId);
    },
  },

  User: {
    orders: async (user: User, args: { first: number }, ctx: Context) => {
      const { rows } = await ctx.db.query<OrderRow>('select * from orders where user_id = $1 order by created_at desc, id limit $2', [user.id, Math.min(Math.max(args.first, 1), 100)]);
      return rows;
    },
  },
  Product: { priceCents: (p: ProductRow) => p.price_cents },
  Order: {
    totalCents: (o: OrderRow) => o.total_cents,
    createdAt: (o: OrderRow) => o.created_at.toISOString(),
    items: async (o: OrderRow, _: unknown, ctx: Context) => (await ctx.loaders.items.load(o.id)).map((i) => ({ product_id: i.product_id, quantity: i.quantity, unitPriceCents: i.unit_price_cents })),
    events: async (o: OrderRow, _: unknown, ctx: Context) => (await ctx.loaders.events.load(o.id)).map((e) => ({ type: e.type, fromStatus: e.from_status, toStatus: e.to_status, source: e.source, createdAt: e.created_at.toISOString() })),
  },
  OrderItem: { product: (i: { product_id: number }, _: unknown, ctx: Context) => ctx.loaders.product.load(i.product_id) },
};

// Tests of the integrity checker itself: a verifier that always answers "all good" proves nothing, so each rule is shown to notice
// the corruption it exists to catch. Each test damages its own data, checks that exactly the right rule complains, and puts it back.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../src/app.js';
import { CHECKS, runChecks } from '../src/integrityChecks.js';
import { CANCEL, advanceTo, gql, newProduct, newUser, placeOrder, startApp } from './helpers.js';

let app: App;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app.close(); });

const failing = async () => (await runChecks(app.db)).filter((r) => r.violations > 0).map((r) => r.name);
const RULE = (fragment: string) => CHECKS.find((c) => c.name.includes(fragment))!.name;

async function paidOrder() {
  const user = await newUser(app);
  const orderId = await placeOrder(app, user, [{ productId: await newProduct(app) }]);
  await advanceTo(app, orderId, 'PAID');
  return { user, orderId };
}

describe('integrity checks', () => {
  it('has a rule for every kind of damage listed in the documentation (9 rules)', () => {
    expect(CHECKS).toHaveLength(9);
  });

  it('finds nothing wrong after a delivered order, a cancelled order and a completed return', async () => {
    const user = await newUser(app);
    const product = await newProduct(app);
    const delivered = await placeOrder(app, user, [{ productId: product }]);
    await advanceTo(app, delivered, 'DELIVERED');

    const cancelled = await placeOrder(app, user, [{ productId: product, quantity: 2 }]);
    await advanceTo(app, cancelled, 'PAID');
    expect((await gql(app, CANCEL, { id: cancelled }, { token: user.token })).errors).toBeUndefined();

    const returned = await placeOrder(app, user, [{ productId: product }]);
    await advanceTo(app, returned, 'DELIVERED');
    await gql(app, 'mutation($id: ID!) { requestReturn(orderId: $id, reason: "Too big") { status } }', { id: returned }, { token: user.token });
    await gql(app, 'mutation($id: ID!) { completeReturn(orderId: $id) { status } }', { id: returned }, { admin: true });

    expect(await failing()).toEqual([]);
  });

  it('notices an order whose total no longer matches its lines', async () => {
    const { orderId } = await paidOrder();
    await app.db.query('update orders set total_cents = total_cents + 1 where id = $1', [orderId]);
    try { expect(await failing()).toContain(RULE('total equals the sum')); }
    finally { await app.db.query('update orders set total_cents = total_cents - 1 where id = $1', [orderId]); }
    expect(await failing()).toEqual([]);
  });

  it('notices an order whose status was changed without a recorded event', async () => {
    const { orderId } = await paidOrder();
    await app.db.query("update orders set status = 'SHIPPED' where id = $1", [orderId]);
    try { expect(await failing()).toContain(RULE('matches the last event')); }
    finally { await app.db.query("update orders set status = 'PAID' where id = $1", [orderId]); }
    expect(await failing()).toEqual([]);
  });

  it('notices an order confirmed twice (a webhook applied twice)', async () => {
    const { orderId } = await paidOrder();
    const extra = (await app.db.query("insert into order_events (order_id, type, from_status, to_status, source) values ($1, 'status_changed', 'PENDING_PAYMENT', 'PAID', 'payment') returning id", [orderId])).rows[0].id;
    try { expect(await failing()).toEqual(expect.arrayContaining([RULE('confirmed twice'), RULE('legal chain')])); }
    finally { await app.db.query('delete from order_events where id = $1', [extra]); }
    expect(await failing()).toEqual([]);
  });

  it('notices a paid order whose customer was never told', async () => {
    const { orderId } = await paidOrder();
    const removed = (await app.db.query("delete from notifications where order_id = $1 and kind = 'order_confirmed' returning user_id, order_id, kind, created_at", [orderId])).rows[0];
    try { expect(await failing()).toContain(RULE('confirmation notification')); }
    finally { await app.db.query('insert into notifications (user_id, order_id, kind, created_at) values ($1, $2, $3, $4)', [removed.user_id, removed.order_id, removed.kind, removed.created_at]); }
    expect(await failing()).toEqual([]);
  });

  it('notices stock that no longer matches the open orders (something oversold or lost)', async () => {
    await app.db.query('update products set stock = stock - 5 where id = 150');
    try { expect(await failing()).toContain(RULE('stock equals what was seeded')); }
    finally { await app.db.query('update products set stock = stock + 5 where id = 150'); }
    expect(await failing()).toEqual([]);
  });

  it('notices an order with no lines', async () => {
    const { orderId } = await paidOrder();
    const lines = (await app.db.query('delete from order_items where order_id = $1 returning *', [orderId])).rows;
    try { expect(await failing()).toContain(RULE('at least one line')); }
    finally { for (const l of lines) await app.db.query('insert into order_items (order_id, product_id, quantity, unit_price_cents) values ($1, $2, $3, $4)', [l.order_id, l.product_id, l.quantity, l.unit_price_cents]); }
    expect(await failing()).toEqual([]);
  });
});

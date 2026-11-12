import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../src/app.js';
import { CANCEL, advanceTo, code, gql, newProduct, newUser, placeOrder, startApp, statusOf, stockOf } from './helpers.js';

let app: App;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app.close(); });

async function order(stock = 20, quantity = 2) {
  const user = await newUser(app);
  const productId = await newProduct(app, { stock });
  const orderId = await placeOrder(app, user, [{ productId, quantity }]);
  return { user, productId, orderId, quantity, stock };
}
const REQUEST_RETURN = 'mutation($id: ID!, $r: String!) { requestReturn(orderId: $id, reason: $r) { status } }';
const COMPLETE_RETURN = 'mutation($id: ID!) { completeReturn(orderId: $id) { status } }';

describe('cancellations', () => {
  it.each(['PENDING_PAYMENT', 'PAID', 'FULFILLING'] as const)('lets the customer cancel while the order is %s, and restocks it', async (state) => {
    const o = await order();
    if (state !== 'PENDING_PAYMENT') await advanceTo(app, o.orderId, state);
    expect(await stockOf(app, o.productId)).toBe(o.stock - o.quantity);
    const r = await gql(app, CANCEL, { id: o.orderId }, { token: o.user.token });
    expect(r.data.cancelOrder.status).toBe('CANCELLED');
    expect(await stockOf(app, o.productId)).toBe(o.stock);
  });

  it.each(['SHIPPED', 'DELIVERED'] as const)('refuses to cancel an order that is already %s, and keeps the stock taken', async (state) => {
    const o = await order();
    await advanceTo(app, o.orderId, state);
    const r = await gql(app, CANCEL, { id: o.orderId }, { token: o.user.token });
    expect(code(r)).toBe('INVALID_TRANSITION');
    expect(await statusOf(app, o.orderId)).toBe(state);
    expect(await stockOf(app, o.productId)).toBe(o.stock - o.quantity);
  });

  it('refuses a second cancellation and does not restock twice', async () => {
    const o = await order();
    await gql(app, CANCEL, { id: o.orderId }, { token: o.user.token });
    expect(code(await gql(app, CANCEL, { id: o.orderId }, { token: o.user.token }))).toBe('INVALID_TRANSITION');
    expect(await stockOf(app, o.productId)).toBe(o.stock);
  });

  it("does not let a customer cancel someone else's order (and does not reveal that it exists)", async () => {
    const o = await order();
    const stranger = await newUser(app);
    const r = await gql(app, CANCEL, { id: o.orderId }, { token: stranger.token });
    expect(code(r)).toBe('NOT_FOUND');
    expect(await statusOf(app, o.orderId)).toBe('PENDING_PAYMENT');
  });

  it('lets an admin cancel on the customer\'s behalf, recorded as "admin"', async () => {
    const o = await order();
    const stranger = await newUser(app); // any logged-in user plus the admin key acts as admin
    const r = await gql(app, CANCEL, { id: o.orderId }, { token: stranger.token, admin: true });
    expect(r.data.cancelOrder.status).toBe('CANCELLED');
    const events = (await app.db.query('select source from order_events where order_id = $1 and to_status = $2', [o.orderId, 'CANCELLED'])).rows;
    expect(events).toEqual([{ source: 'admin' }]);
  });

  it('refuses a malformed order id without touching the database', async () => {
    const user = await newUser(app);
    const before = app.stats.queries;
    expect(code(await gql(app, CANCEL, { id: 'not-a-uuid; drop table orders' }, { token: user.token }))).toBe('NOT_FOUND');
    expect(app.stats.queries - before).toBeLessThanOrEqual(2); // only the login lookup
  });

  it('records the cancellation and notifies the customer', async () => {
    const o = await order();
    await gql(app, CANCEL, { id: o.orderId }, { token: o.user.token });
    const n = await gql(app, '{ notifications { kind } }', {}, { token: o.user.token });
    expect(n.data.notifications.map((x: any) => x.kind)).toEqual(['order_cancelled']);
  });
});

describe('returns', () => {
  it('accepts a return for a delivered order and completes it: refund state, stock back, customer told', async () => {
    const o = await order(20, 3);
    await advanceTo(app, o.orderId, 'DELIVERED');
    expect((await gql(app, REQUEST_RETURN, { id: o.orderId, r: 'Too small' }, { token: o.user.token })).data.requestReturn.status).toBe('RETURN_REQUESTED');
    expect((await app.db.query('select reason, status from returns where order_id = $1', [o.orderId])).rows).toEqual([{ reason: 'Too small', status: 'REQUESTED' }]);
    expect(await stockOf(app, o.productId)).toBe(17); // still with the customer

    expect((await gql(app, COMPLETE_RETURN, { id: o.orderId }, { admin: true })).data.completeReturn.status).toBe('RETURNED');
    expect(await stockOf(app, o.productId)).toBe(20);
    expect((await app.db.query('select status from returns where order_id = $1', [o.orderId])).rows[0].status).toBe('COMPLETED');
    const n = await gql(app, '{ notifications { kind } }', {}, { token: o.user.token });
    expect(n.data.notifications.map((x: any) => x.kind)).toContain('return_completed');
  });

  it.each(['PENDING_PAYMENT', 'PAID', 'FULFILLING', 'SHIPPED'] as const)('refuses a return for an order that is only %s', async (state) => {
    const o = await order();
    if (state !== 'PENDING_PAYMENT') await advanceTo(app, o.orderId, state);
    expect(code(await gql(app, REQUEST_RETURN, { id: o.orderId, r: 'Changed my mind' }, { token: o.user.token }))).toBe('INVALID_TRANSITION');
    expect((await app.db.query('select count(*)::int as n from returns where order_id = $1', [o.orderId])).rows[0].n).toBe(0);
  });

  it('refuses a return after the 30-day window, and accepts one on day 29', async () => {
    const late = await order();
    await advanceTo(app, late.orderId, 'DELIVERED');
    await app.db.query("update orders set delivered_at = now() - interval '31 days' where id = $1", [late.orderId]);
    expect(code(await gql(app, REQUEST_RETURN, { id: late.orderId, r: 'Late' }, { token: late.user.token }))).toBe('RETURN_WINDOW_CLOSED');
    expect(await statusOf(app, late.orderId)).toBe('DELIVERED');

    const ok = await order();
    await advanceTo(app, ok.orderId, 'DELIVERED');
    await app.db.query("update orders set delivered_at = now() - interval '29 days' where id = $1", [ok.orderId]);
    expect((await gql(app, REQUEST_RETURN, { id: ok.orderId, r: 'Just in time' }, { token: ok.user.token })).errors).toBeUndefined();
  });

  it('needs a reason', async () => {
    const o = await order();
    await advanceTo(app, o.orderId, 'DELIVERED');
    expect(code(await gql(app, REQUEST_RETURN, { id: o.orderId, r: '   ' }, { token: o.user.token }))).toBe('BAD_USER_INPUT');
  });

  it('allows only one return per order', async () => {
    const o = await order();
    await advanceTo(app, o.orderId, 'DELIVERED');
    await gql(app, REQUEST_RETURN, { id: o.orderId, r: 'First' }, { token: o.user.token });
    expect(code(await gql(app, REQUEST_RETURN, { id: o.orderId, r: 'Second' }, { token: o.user.token }))).toBe('INVALID_TRANSITION');
  });

  it("does not let a customer return someone else's order", async () => {
    const o = await order();
    await advanceTo(app, o.orderId, 'DELIVERED');
    const stranger = await newUser(app);
    expect(code(await gql(app, REQUEST_RETURN, { id: o.orderId, r: 'Not mine' }, { token: stranger.token }))).toBe('NOT_FOUND');
  });

  it('keeps completing a return an admin-only operation', async () => {
    const o = await order();
    await advanceTo(app, o.orderId, 'DELIVERED');
    await gql(app, REQUEST_RETURN, { id: o.orderId, r: 'Faulty' }, { token: o.user.token });
    expect(code(await gql(app, COMPLETE_RETURN, { id: o.orderId }, { token: o.user.token }))).toBe('FORBIDDEN');
    expect(await statusOf(app, o.orderId)).toBe('RETURN_REQUESTED');
  });
});

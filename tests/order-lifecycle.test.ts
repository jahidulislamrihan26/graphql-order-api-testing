import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../src/app.js';
import { ALLOWED, STATUSES, canTransition, type Status } from '../src/stateMachine.js';
import { ORDER, advanceTo, code, event, gql, newProduct, newUser, placeOrder, sendWebhook, statusOf } from './helpers.js';

let app: App;
beforeAll(async () => { app = await (await import('./helpers.js')).startApp(); });
afterAll(async () => { await app.close(); });

describe('state machine rules', () => {
  it('lists every legal move, and nothing else is allowed (all 64 pairs)', () => {
    for (const from of STATUSES) for (const to of STATUSES) expect(canTransition(from, to), `${from} -> ${to}`).toBe(ALLOWED[from].includes(to));
  });
  it('has no way out of the two final states', () => {
    expect(ALLOWED.CANCELLED).toEqual([]);
    expect(ALLOWED.RETURNED).toEqual([]);
  });
  it('never allows an order to move backwards', () => {
    const rank: Record<string, number> = { PENDING_PAYMENT: 0, PAID: 1, FULFILLING: 2, SHIPPED: 3, DELIVERED: 4, RETURN_REQUESTED: 5, RETURNED: 6 };
    for (const from of STATUSES) for (const to of ALLOWED[from]) if (to !== 'CANCELLED') expect(rank[to], `${from} -> ${to}`).toBeGreaterThan(rank[from]);
  });
});

describe('a normal order, end to end', () => {
  it('moves PENDING_PAYMENT, PAID, FULFILLING, SHIPPED, DELIVERED and records every step', async () => {
    const user = await newUser(app);
    const orderId = await placeOrder(app, user, [{ productId: await newProduct(app) }]);
    expect(await statusOf(app, orderId)).toBe('PENDING_PAYMENT');
    await advanceTo(app, orderId, 'DELIVERED');

    const r = await gql(app, ORDER, { id: orderId }, { token: user.token });
    expect(r.data.order.status).toBe('DELIVERED');
    expect(r.data.order.events.map((e: any) => [e.fromStatus, e.toStatus, e.source])).toEqual([
      [null, 'PENDING_PAYMENT', 'customer'],
      ['PENDING_PAYMENT', 'PAID', 'payment'],
      ['PAID', 'FULFILLING', 'warehouse'],
      ['FULFILLING', 'SHIPPED', 'shipment'],
      ['SHIPPED', 'DELIVERED', 'shipment'],
    ]);
  });

  it('sends the customer a notification for each milestone, in order', async () => {
    const user = await newUser(app);
    const orderId = await placeOrder(app, user, [{ productId: await newProduct(app) }]);
    await advanceTo(app, orderId, 'DELIVERED');
    const r = await gql(app, '{ notifications { kind orderId } }', {}, { token: user.token });
    expect(r.data.notifications.map((n: any) => n.kind)).toEqual(['order_confirmed', 'order_shipped', 'order_delivered']);
    expect(new Set(r.data.notifications.map((n: any) => n.orderId))).toEqual(new Set([orderId]));
  });

  it("does not show one customer another customer's notifications", async () => {
    const [a, b] = [await newUser(app), await newUser(app)];
    const orderId = await placeOrder(app, a, [{ productId: await newProduct(app) }]);
    await advanceTo(app, orderId, 'PAID');
    expect((await gql(app, '{ notifications { kind } }', {}, { token: b.token })).data.notifications).toEqual([]);
  });
});

describe('moves that must be refused', () => {
  const cases: Array<{ name: string; from: Status; act: (orderId: string) => Promise<{ code?: string; applied: boolean }> }> = [
    { name: 'the warehouse starts fulfilling an unpaid order', from: 'PENDING_PAYMENT', act: async (id) => asGql(await gql(app, 'mutation($id: ID!) { markFulfilling(orderId: $id) { status } }', { id }, { admin: true })) },
    { name: 'a shipment is reported for an unpaid order', from: 'PENDING_PAYMENT', act: async (id) => asHook(await sendWebhook(app, event('shipment.shipped', id))) },
    { name: 'a delivery is reported for an order that has not shipped', from: 'FULFILLING', act: async (id) => asHook(await sendWebhook(app, event('shipment.delivered', id))) },
    { name: 'the warehouse completes a return that was never requested', from: 'DELIVERED', act: async (id) => asGql(await gql(app, 'mutation($id: ID!) { completeReturn(orderId: $id) { status } }', { id }, { admin: true })) },
    { name: 'fulfilling is started twice', from: 'FULFILLING', act: async (id) => asGql(await gql(app, 'mutation($id: ID!) { markFulfilling(orderId: $id) { status } }', { id }, { admin: true })) },
  ];
  const asGql = (r: { errors?: Array<{ extensions?: { code?: string } }> }) => ({ code: r.errors?.[0]?.extensions?.code, applied: !r.errors });
  const asHook = (r: { body: { status: string; reason?: string } }) => ({ code: r.body.reason, applied: r.body.status === 'applied' });

  for (const c of cases) {
    it(`refuses it when ${c.name}, and leaves the order as it was`, async () => {
      const user = await newUser(app);
      const orderId = await placeOrder(app, user, [{ productId: await newProduct(app) }]);
      if (c.from !== 'PENDING_PAYMENT') await advanceTo(app, orderId, c.from as 'PAID' | 'FULFILLING' | 'SHIPPED' | 'DELIVERED');
      const result = await c.act(orderId);
      expect(result.applied).toBe(false);
      expect(await statusOf(app, orderId)).toBe(c.from);
    });
  }

  it('reports INVALID_TRANSITION to the caller of a GraphQL mutation', async () => {
    const user = await newUser(app);
    const orderId = await placeOrder(app, user, [{ productId: await newProduct(app) }]);
    const r = await gql(app, 'mutation($id: ID!) { markFulfilling(orderId: $id) { status } }', { id: orderId }, { admin: true });
    expect(code(r)).toBe('INVALID_TRANSITION');
  });
});

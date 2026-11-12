import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../src/app.js';
import { advanceTo, event, gql, newProduct, newUser, placeOrder, sendWebhook, startApp, statusOf, stockOf } from './helpers.js';

let app: App;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app.close(); });

async function freshOrder(stock = 10, quantity = 1) {
  const user = await newUser(app);
  const productId = await newProduct(app, { stock });
  const orderId = await placeOrder(app, user, [{ productId, quantity }]);
  return { user, productId, orderId };
}
const countEvents = async (orderId: string, type: string) =>
  (await app.db.query('select count(*)::int as n from order_events where order_id = $1 and to_status = $2', [orderId, type])).rows[0].n;

describe('who is calling: signature and timestamp', () => {
  it('applies a correctly signed event', async () => {
    const { orderId } = await freshOrder();
    const r = await sendWebhook(app, event('payment.succeeded', orderId));
    expect(r).toEqual({ status: 200, body: { status: 'applied', orderStatus: 'PAID' } });
  });

  it('rejects a wrong signature and changes nothing', async () => {
    const { orderId } = await freshOrder();
    const r = await sendWebhook(app, event('payment.succeeded', orderId), { secret: 'not-the-shared-secret' });
    expect(r.status).toBe(401);
    expect(await statusOf(app, orderId)).toBe('PENDING_PAYMENT');
  });

  it('rejects a missing signature', async () => {
    const { orderId } = await freshOrder();
    expect((await sendWebhook(app, event('payment.succeeded', orderId), { omitSignature: true })).status).toBe(401);
  });

  it('rejects a body that was changed after it was signed', async () => {
    const { orderId, productId } = await freshOrder();
    const signed = JSON.stringify(event('payment.failed', orderId));
    const r = await sendWebhook(app, {}, { rawBody: signed.replace('payment.failed', 'payment.succeeded'), signature: (await import('../src/webhooks.js')).signPayload(app.config.webhookSecret, Math.floor(Date.now() / 1000), signed) });
    expect(r.status).toBe(401);
    expect(await statusOf(app, orderId)).toBe('PENDING_PAYMENT');
    expect(await stockOf(app, productId)).toBe(9);
  });

  it('rejects a captured request replayed later (timestamp too old)', async () => {
    const { orderId } = await freshOrder();
    const r = await sendWebhook(app, event('payment.succeeded', orderId), { timestamp: Math.floor(Date.now() / 1000) - 3600 });
    expect(r.status).toBe(401);
    expect(await statusOf(app, orderId)).toBe('PENDING_PAYMENT');
  });

  it('rejects a timestamp from the future', async () => {
    const { orderId } = await freshOrder();
    expect((await sendWebhook(app, event('payment.succeeded', orderId), { timestamp: Math.floor(Date.now() / 1000) + 3600 })).status).toBe(401);
  });

  it('only accepts POST', async () => {
    const res = await fetch(`${app.url}/webhooks/events`);
    expect(res.status).toBe(405);
  });
});

describe('what they are saying: bad input', () => {
  it('rejects a body that is not JSON', async () => {
    expect((await sendWebhook(app, {}, { rawBody: 'not json at all' })).status).toBe(400);
  });
  it.each([[{ type: 'payment.succeeded' }], [{ id: 'e1', orderId: 'x' }], [{ id: 'e1', type: 'payment.succeeded', orderId: 'not-a-uuid' }]])('rejects an event with missing or malformed fields: %j', async (body) => {
    expect((await sendWebhook(app, body)).status).toBe(400);
  });
  it('rejects an event type it does not know (422) and does not mark the id as used', async () => {
    const { orderId } = await freshOrder();
    const id = `evt-unknown-${Date.now()}`;
    expect((await sendWebhook(app, event('refund.created', orderId, id))).status).toBe(422);
    expect(await app.redis.get(`webhook:${id}`)).toBeNull();
  });
  it('answers 404 for an order that does not exist, so the provider can retry once it does', async () => {
    const id = `evt-missing-${Date.now()}`;
    expect((await sendWebhook(app, event('payment.succeeded', '00000000-0000-4000-8000-000000000000', id))).status).toBe(404);
    expect(await app.redis.get(`webhook:${id}`)).toBeNull();
  });
});

describe('providers retry: the same event must never be applied twice', () => {
  it('answers "duplicate" and changes nothing the second time', async () => {
    const { orderId } = await freshOrder();
    const ev = event('payment.succeeded', orderId);
    expect((await sendWebhook(app, ev)).body.status).toBe('applied');
    expect((await sendWebhook(app, ev)).body).toEqual({ status: 'duplicate' });
    expect(await countEvents(orderId, 'PAID')).toBe(1);
    const n = await gql(app, '{ notifications { kind } }', {}, { token: (await app.db.query('select u.token from orders o join users u on u.id = o.user_id where o.id = $1', [orderId])).rows[0].token });
    expect(n.data.notifications.filter((x: any) => x.kind === 'order_confirmed')).toHaveLength(1);
  });

  it('applies exactly once when the same event arrives ten times at the same moment', async () => {
    const { orderId } = await freshOrder();
    const ev = event('payment.succeeded', orderId);
    const results = await Promise.all(Array.from({ length: 10 }, () => sendWebhook(app, ev)));
    expect(results.filter((r) => r.body.status === 'applied')).toHaveLength(1);
    expect(results.filter((r) => r.body.status === 'duplicate')).toHaveLength(9);
    expect(await countEvents(orderId, 'PAID')).toBe(1);
  });

  it('still blocks a duplicate if Redis has lost its memory of the event (the database is the second line of defence)', async () => {
    const { orderId } = await freshOrder();
    const ev = event('payment.succeeded', orderId);
    await sendWebhook(app, ev);
    await app.redis.del(`webhook:${ev.id}`);
    expect((await sendWebhook(app, ev)).body.status).toBe('duplicate');
    expect(await countEvents(orderId, 'PAID')).toBe(1);
  });

  it('treats two different events with different ids as two events', async () => {
    const { orderId } = await freshOrder();
    await advanceTo(app, orderId, 'SHIPPED');
    expect((await sendWebhook(app, event('shipment.delivered', orderId))).body.status).toBe('applied');
  });
});

describe('events that arrive early, late or out of order', () => {
  it('ignores a delivery notice that arrives before the shipping notice (and the order stays put)', async () => {
    const { orderId } = await freshOrder();
    await advanceTo(app, orderId, 'FULFILLING');
    const r = await sendWebhook(app, event('shipment.delivered', orderId));
    expect(r).toEqual({ status: 200, body: { status: 'ignored', reason: 'INVALID_TRANSITION' } });
    expect(await statusOf(app, orderId)).toBe('FULFILLING');
  });

  it('ignores a payment confirmation for an order that was already cancelled, and does not take the stock again', async () => {
    const { user, orderId, productId } = await freshOrder(10, 2);
    await gql(app, 'mutation($id: ID!) { cancelOrder(orderId: $id) { status } }', { id: orderId }, { token: user.token });
    expect(await stockOf(app, productId)).toBe(10);
    const r = await sendWebhook(app, event('payment.succeeded', orderId));
    expect(r.body.status).toBe('ignored');
    expect(await statusOf(app, orderId)).toBe('CANCELLED');
    expect(await stockOf(app, productId)).toBe(10);
  });

  it('ignores a "payment failed" notice for an order that is already paid', async () => {
    const { orderId } = await freshOrder();
    await advanceTo(app, orderId, 'PAID');
    const r = await sendWebhook(app, event('payment.failed', orderId));
    expect(r.body.status).toBe('ignored');
    expect(await statusOf(app, orderId)).toBe('PAID');
  });

  it('ignores a repeated shipping notice that carries a new event id', async () => {
    const { orderId } = await freshOrder();
    await advanceTo(app, orderId, 'SHIPPED');
    expect((await sendWebhook(app, event('shipment.shipped', orderId))).body.status).toBe('ignored');
    expect(await countEvents(orderId, 'SHIPPED')).toBe(1);
  });
});

describe('failure scenarios', () => {
  it('cancels the order and puts the stock back when payment fails', async () => {
    const { user, orderId, productId } = await freshOrder(10, 3);
    expect(await stockOf(app, productId)).toBe(7);
    const r = await sendWebhook(app, event('payment.failed', orderId));
    expect(r.body).toEqual({ status: 'applied', orderStatus: 'CANCELLED' });
    expect(await stockOf(app, productId)).toBe(10);
    const n = await gql(app, '{ notifications { kind } }', {}, { token: user.token });
    expect(n.data.notifications.map((x: any) => x.kind)).toEqual(['order_cancelled']);
  });

  it('the cached stock figure is corrected after a failed payment (no stale cache)', async () => {
    const { orderId, productId } = await freshOrder(10, 3);
    expect((await gql(app, 'query($id: ID!) { product(id: $id) { stock } }', { id: String(productId) })).data.product.stock).toBe(7); // fills the cache
    await sendWebhook(app, event('payment.failed', orderId));
    expect((await gql(app, 'query($id: ID!) { product(id: $id) { stock } }', { id: String(productId) })).data.product.stock).toBe(10);
  });

  it('a callback that fails inside the service can be retried: nothing is half-applied and the event id is released', async () => {
    const { orderId } = await freshOrder();
    const ev = event('payment.succeeded', orderId);
    // Simulate a database fault part-way through, for this one order only (other tests run in parallel against the same database).
    const fault = `sim_fail_${orderId.replace(/-/g, '')}`;
    await app.db.query(`create function ${fault}() returns trigger language plpgsql as $$ begin if new.order_id = '${orderId}' then raise exception 'simulated fault'; end if; return new; end $$`);
    await app.db.query(`create trigger ${fault} before insert on notifications for each row execute function ${fault}()`);
    try {
      expect((await sendWebhook(app, ev)).status).toBe(500);
    } finally {
      await app.db.query(`drop trigger ${fault} on notifications`);
      await app.db.query(`drop function ${fault}()`);
    }
    expect(await statusOf(app, orderId)).toBe('PENDING_PAYMENT');
    expect(await app.redis.get(`webhook:${ev.id}`)).toBeNull();
    await app.db.query('delete from webhook_events where event_id = $1', [ev.id]); // the failed attempt's marker, if the fault hit after it
    expect((await sendWebhook(app, ev)).body.status).toBe('applied');
  });
});

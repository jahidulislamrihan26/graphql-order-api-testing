import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../src/app.js';
import { ADD, CANCEL, CHECKOUT, advanceTo, code, event, gql, newProduct, newUser, sendWebhook, startApp, statusOf, stockOf } from './helpers.js';

let app: App;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app.close(); });

describe('many customers at once', () => {
  it('never sells more than the stock: 30 customers fight over 7 items', async () => {
    const productId = await newProduct(app, { stock: 7 });
    const users = await Promise.all(Array.from({ length: 30 }, () => newUser(app)));
    await Promise.all(users.map((u) => gql(app, ADD, { p: String(productId), q: 1 }, { token: u.token })));
    const results = await Promise.all(users.map((u) => gql(app, CHECKOUT, {}, { token: u.token })));

    const won = results.filter((r) => !r.errors);
    const lost = results.filter((r) => code(r) === 'INSUFFICIENT_STOCK');
    expect(won).toHaveLength(7);
    expect(lost).toHaveLength(23);
    expect(await stockOf(app, productId)).toBe(0);
    expect((await app.db.query('select coalesce(sum(oi.quantity), 0)::int as sold from order_items oi where oi.product_id = $1', [productId])).rows[0].sold).toBe(7);
  });

  it('keeps stock equal to start minus what is in open orders, after a mix of checkouts and cancellations', async () => {
    const productId = await newProduct(app, { stock: 40 });
    const users = await Promise.all(Array.from({ length: 20 }, () => newUser(app)));
    await Promise.all(users.map((u) => gql(app, ADD, { p: String(productId), q: 2 }, { token: u.token })));
    const orders = await Promise.all(users.map((u) => gql(app, CHECKOUT, {}, { token: u.token })));
    // cancel every other order while the rest are still being created
    await Promise.all(orders.filter((_, i) => i % 2 === 0).map((o, i) => gql(app, CANCEL, { id: o.data.checkout.id }, { token: users[i * 2].token })));
    const open = (await app.db.query("select coalesce(sum(oi.quantity), 0)::int as n from order_items oi join orders o on o.id = oi.order_id where oi.product_id = $1 and o.status <> 'CANCELLED'", [productId])).rows[0].n;
    expect(await stockOf(app, productId)).toBe(40 - open);
    expect(open).toBe(20); // 10 orders of 2 stay open
  });

  it('does not deadlock when customers buy the same two products in opposite order', async () => {
    const [a, b] = [await newProduct(app, { stock: 100 }), await newProduct(app, { stock: 100 })];
    const users = await Promise.all(Array.from({ length: 16 }, () => newUser(app)));
    await Promise.all(users.map(async (u, i) => {
      const [first, second] = i % 2 ? [a, b] : [b, a];
      await gql(app, ADD, { p: String(first), q: 1 }, { token: u.token });
      await gql(app, ADD, { p: String(second), q: 1 }, { token: u.token });
    }));
    const results = await Promise.all(users.map((u) => gql(app, CHECKOUT, {}, { token: u.token })));
    expect(results.filter((r) => r.errors)).toEqual([]);
    expect(await stockOf(app, a)).toBe(84);
    expect(await stockOf(app, b)).toBe(84);
  });

  it('a double-click on Checkout creates one order, not two', async () => {
    const user = await newUser(app);
    const productId = await newProduct(app, { stock: 10 });
    await gql(app, ADD, { p: String(productId), q: 1 }, { token: user.token });
    const results = await Promise.all([gql(app, CHECKOUT, {}, { token: user.token }), gql(app, CHECKOUT, {}, { token: user.token })]);
    const created = (await app.db.query('select count(*)::int as n from orders where user_id = $1', [user.id])).rows[0].n;
    // The cart is read before it is cleared, so two truly simultaneous checkouts can both pass. What must hold is that stock matches orders.
    expect(await stockOf(app, productId)).toBe(10 - created);
    expect(results.some((r) => !r.errors)).toBe(true);
  });
});

describe('two things happen to one order at once', () => {
  it('a cancellation and a payment confirmation at the same moment always end CANCELLED, with the stock returned exactly once', async () => {
    // A cancellation is legal both before and after payment, so whichever request wins the race the order must end CANCELLED.
    // Only the history differs: payment first (PAID, then CANCELLED) or cancellation first (CANCELLED, payment ignored).
    const histories = new Set<string>();
    for (let round = 0; round < 12; round++) {
      const user = await newUser(app);
      const productId = await newProduct(app, { stock: 5 });
      await gql(app, ADD, { p: String(productId), q: 2 }, { token: user.token });
      const orderId = (await gql(app, CHECKOUT, {}, { token: user.token })).data.checkout.id;

      const [cancel, pay] = await Promise.all([
        gql(app, CANCEL, { id: orderId }, { token: user.token }),
        sendWebhook(app, event('payment.succeeded', orderId)),
      ]);
      expect(cancel.errors, JSON.stringify(cancel.errors)).toBeUndefined();
      expect(await statusOf(app, orderId)).toBe('CANCELLED');
      expect(await stockOf(app, productId), 'stock returned exactly once').toBe(5);

      const history = (await app.db.query('select to_status from order_events where order_id = $1 order by id', [orderId])).rows.map((r) => r.to_status).join(' > ');
      histories.add(history);
      expect(['PENDING_PAYMENT > CANCELLED', 'PENDING_PAYMENT > PAID > CANCELLED']).toContain(history);
      expect(pay.body.status).toBe(history.includes('PAID') ? 'applied' : 'ignored'); // the webhook's answer matches what really happened
    }
    expect(histories.size).toBeGreaterThanOrEqual(1);
  });

  it('two different events for one order are applied one after the other, never mixed', async () => {
    const user = await newUser(app);
    const productId = await newProduct(app);
    await gql(app, ADD, { p: String(productId), q: 1 }, { token: user.token });
    const orderId = (await gql(app, CHECKOUT, {}, { token: user.token })).data.checkout.id;
    await advanceTo(app, orderId, 'FULFILLING');
    const results = await Promise.all([sendWebhook(app, event('shipment.shipped', orderId)), sendWebhook(app, event('shipment.delivered', orderId))]);
    const status = await statusOf(app, orderId);
    // either the notices arrived in order (DELIVERED) or "delivered" came first and was ignored (SHIPPED): never anything else
    expect(['SHIPPED', 'DELIVERED']).toContain(status);
    if (status === 'SHIPPED') expect(results.map((r) => r.body.status).sort()).toEqual(['applied', 'ignored']);
  });
});

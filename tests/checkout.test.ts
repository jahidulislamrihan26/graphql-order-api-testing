import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../src/app.js';
import { ADD, CHECKOUT, ORDER, code, gql, newProduct, newUser, placeOrder, startApp, stockOf } from './helpers.js';

let app: App;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app.close(); });

describe('cart', () => {
  it('adds products, adds up the total from the database prices, and merges repeats', async () => {
    const user = await newUser(app);
    const [p1, p2] = [await newProduct(app, { priceCents: 1250 }), await newProduct(app, { priceCents: 399 })];
    await gql(app, ADD, { p: String(p1), q: 2 }, { token: user.token });
    await gql(app, ADD, { p: String(p2), q: 1 }, { token: user.token });
    const r = await gql(app, ADD, { p: String(p1), q: 1 }, { token: user.token });
    expect(r.data.addToCart.totalCents).toBe(3 * 1250 + 399);
    expect(r.data.addToCart.items.map((i: any) => [Number(i.product.id), i.quantity])).toEqual([[p1, 3], [p2, 1]]);
  });

  it('removes a product', async () => {
    const user = await newUser(app);
    const p = await newProduct(app);
    await gql(app, ADD, { p: String(p), q: 2 }, { token: user.token });
    const r = await gql(app, 'mutation($p: ID!) { removeFromCart(productId: $p) { items { quantity } totalCents } }', { p: String(p) }, { token: user.token });
    expect(r.data.removeFromCart).toEqual({ items: [], totalCents: 0 });
  });

  it.each([[0], [-1], [1.5]])('rejects a quantity of %s', async (q) => {
    const user = await newUser(app);
    const r = await gql(app, ADD, { p: String(await newProduct(app)), q }, { token: user.token });
    expect(r.errors, JSON.stringify(r)).toBeDefined();
  });

  it('allows at most 99 of one product, counting what is already in the cart', async () => {
    const user = await newUser(app);
    const p = String(await newProduct(app));
    expect((await gql(app, ADD, { p, q: 99 }, { token: user.token })).errors).toBeUndefined();
    expect(code(await gql(app, ADD, { p, q: 1 }, { token: user.token }))).toBe('BAD_USER_INPUT');
  });

  it('refuses a product that does not exist', async () => {
    const user = await newUser(app);
    expect(code(await gql(app, ADD, { p: '999999999', q: 1 }, { token: user.token }))).toBe('NOT_FOUND');
  });

  it('keeps every customer\'s cart separate', async () => {
    const [a, b] = [await newUser(app), await newUser(app)];
    await gql(app, ADD, { p: String(await newProduct(app)), q: 1 }, { token: a.token });
    expect((await gql(app, '{ cart { items { quantity } } }', {}, { token: b.token })).data.cart.items).toEqual([]);
  });
});

describe('checkout', () => {
  it('creates a PENDING_PAYMENT order with the prices as they were at checkout', async () => {
    const user = await newUser(app);
    const p = await newProduct(app, { priceCents: 2000 });
    await gql(app, ADD, { p: String(p), q: 3 }, { token: user.token });
    const r = await gql(app, CHECKOUT, {}, { token: user.token });
    expect(r.data.checkout.status).toBe('PENDING_PAYMENT');
    expect(r.data.checkout.totalCents).toBe(6000);

    await app.db.query('update products set price_cents = 9999 where id = $1', [p]); // a later price change must not rewrite history
    const again = await gql(app, ORDER, { id: r.data.checkout.id }, { token: user.token });
    expect(again.data.order.totalCents).toBe(6000);
    expect(again.data.order.items).toEqual([{ quantity: 3, unitPriceCents: 2000 }]);
  });

  it('takes the stock, and empties the cart', async () => {
    const user = await newUser(app);
    const p = await newProduct(app, { stock: 10 });
    await placeOrder(app, user, [{ productId: p, quantity: 4 }]);
    expect(await stockOf(app, p)).toBe(6);
    expect((await gql(app, '{ cart { items { quantity } } }', {}, { token: user.token })).data.cart.items).toEqual([]);
  });

  it('refuses an empty cart', async () => {
    const user = await newUser(app);
    expect(code(await gql(app, CHECKOUT, {}, { token: user.token }))).toBe('EMPTY_CART');
  });

  it('refuses when there is not enough stock, and changes nothing', async () => {
    const user = await newUser(app);
    const p = await newProduct(app, { stock: 2 });
    await gql(app, ADD, { p: String(p), q: 3 }, { token: user.token });
    expect(code(await gql(app, CHECKOUT, {}, { token: user.token }))).toBe('INSUFFICIENT_STOCK');
    expect(await stockOf(app, p)).toBe(2);
    expect((await app.db.query('select count(*)::int as n from orders where user_id = $1', [user.id])).rows[0].n).toBe(0);
  });

  it('is all or nothing: when the second product is short, the first one keeps its stock', async () => {
    const user = await newUser(app);
    const [plenty, short] = [await newProduct(app, { stock: 50 }), await newProduct(app, { stock: 1 })];
    await gql(app, ADD, { p: String(plenty), q: 5 }, { token: user.token });
    await gql(app, ADD, { p: String(short), q: 2 }, { token: user.token });
    expect(code(await gql(app, CHECKOUT, {}, { token: user.token }))).toBe('INSUFFICIENT_STOCK');
    expect(await stockOf(app, plenty)).toBe(50);
    expect(await stockOf(app, short)).toBe(1);
    expect((await gql(app, '{ cart { items { quantity } } }', {}, { token: user.token })).data.cart.items).toHaveLength(2); // the cart is kept
  });

  it('cannot be completed twice from the same cart', async () => {
    const user = await newUser(app);
    const p = await newProduct(app, { stock: 10 });
    await placeOrder(app, user, [{ productId: p }]);
    expect(code(await gql(app, CHECKOUT, {}, { token: user.token }))).toBe('EMPTY_CART');
    expect(await stockOf(app, p)).toBe(9);
  });

  it('needs a login', async () => {
    expect(code(await gql(app, CHECKOUT))).toBe('UNAUTHENTICATED');
    expect(code(await gql(app, CHECKOUT, {}, { token: 'not-a-real-token' }))).toBe('UNAUTHENTICATED');
  });
});

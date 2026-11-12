import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../src/app.js';
import { ADD, CANCEL, CHECKOUT, advanceTo, code, gql, newProduct, newUser, placeOrder, startApp } from './helpers.js';

let app: App;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app.close(); });

describe('requests the schema must refuse', () => {
  it('rejects a field that does not exist, with a validation error and HTTP 400', async () => {
    const r = await gql(app, '{ products { items { id password } } }');
    expect(r.status).toBe(400);
    expect(code(r)).toBe('GRAPHQL_VALIDATION_FAILED');
  });
  it('rejects a variable of the wrong type', async () => {
    const user = await newUser(app);
    const r = await gql(app, ADD, { p: String(await newProduct(app)), q: 'two' }, { token: user.token });
    expect(r.status).toBe(400);
    expect(r.errors?.[0].message).toMatch(/Int/);
  });
  it('rejects a missing required variable', async () => {
    const r = await gql(app, 'query($id: ID!) { product(id: $id) { id } }', {});
    expect(r.status).toBe(400);
  });
  it('rejects a query that is not valid GraphQL', async () => {
    const r = await gql(app, '{ products { ');
    expect(r.status).toBe(400);
    expect(code(r)).toBe('GRAPHQL_PARSE_FAILED');
  });
  it('rejects a request with no query at all', async () => {
    const res = await fetch(`${app.url}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/graphql-response+json' }, body: '{}' });
    expect(res.status).toBe(400);
  });
  it('treats an attempt to inject SQL through an id as plain bad input', async () => {
    const r = await gql(app, 'query($id: ID!) { product(id: $id) { id } }', { id: "1; drop table products; --" });
    expect(code(r)).toBe('BAD_USER_INPUT');
    expect((await app.db.query('select count(*)::int as n from products')).rows[0].n).toBeGreaterThan(0);
  });
  it('does not leak internal details when something breaks inside the service', async () => {
    const user = await newUser(app);
    const orderId = await placeOrder(app, user, [{ productId: await newProduct(app) }]);
    // a database fault for this one order only (other tests run in parallel against the same database)
    const fault = `sim_fail_${orderId.replace(/-/g, '')}`;
    await app.db.query(`create function ${fault}() returns trigger language plpgsql as $$ begin if new.order_id = '${orderId}' then raise exception 'secret table name orders_internal'; end if; return new; end $$`);
    await app.db.query(`create trigger ${fault} before insert on order_events for each row execute function ${fault}()`);
    try {
      const r = await gql(app, CANCEL, { id: orderId }, { token: user.token });
      expect(code(r)).toBe('INTERNAL_SERVER_ERROR');
      expect(JSON.stringify(r)).not.toMatch(/secret|orders_internal|trigger|plpgsql|postgres/i);
    } finally {
      await app.db.query(`drop trigger ${fault} on order_events`);
      await app.db.query(`drop function ${fault}()`);
    }
  });
});

describe('query depth limit', () => {
  it('accepts a realistic nested query (depth 5)', async () => {
    const user = await newUser(app);
    await placeOrder(app, user, [{ productId: await newProduct(app) }]);
    const r = await gql(app, '{ me { orders { items { product { name } } } } }', {}, { token: user.token });
    expect(r.errors).toBeUndefined();
    expect(r.data.me.orders[0].items[0].product.name).toMatch(/^Test product/);
  });
  it('rejects a query nested beyond the limit, before it reaches the database', async () => {
    const q = `{ me { orders { items { product { name } } } } }`;
    const tight = await startApp({ maxQueryDepth: 3 });
    try {
      const before = tight.stats.queries;
      const r = await gql(tight, q, {}, { token: (await newUser(tight)).token });
      expect(code(r)).toBe('QUERY_TOO_DEEP');
      expect(tight.stats.queries - before).toBe(1); // only the login lookup: nothing was executed
    } finally { await tight.close(); }
  });
  it('counts depth through fragments too', async () => {
    const tight = await startApp({ maxQueryDepth: 3 });
    try {
      const q = 'fragment P on OrderItem { product { name } } { me { orders { items { ...P } } } }';
      expect(code(await gql(tight, q, {}, { token: (await newUser(tight)).token }))).toBe('QUERY_TOO_DEEP');
    } finally { await tight.close(); }
  });
  it('does not count introspection fields against the limit', async () => {
    expect((await gql(app, '{ __schema { queryType { name } } }')).data.__schema.queryType.name).toBe('Query');
  });
});

describe('pagination', () => {
  it('walks the whole catalogue page by page: no product twice, none missed, in id order', async () => {
    const seen: number[] = [];
    let cursor: string | null = null;
    for (let pages = 0; pages < 100; pages++) {
      const r: any = await gql(app, 'query($after: ID) { products(first: 50, after: $after) { items { id } nextCursor } }', { after: cursor });
      seen.push(...r.data.products.items.map((p: any) => Number(p.id)));
      cursor = r.data.products.nextCursor;
      if (!cursor) break;
    }
    const total = (await app.db.query('select count(*)::int as n from products')).rows[0].n;
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });
  it('returns a null cursor on the last page', async () => {
    const last = (await app.db.query('select max(id) as m from products')).rows[0].m;
    const r = await gql(app, 'query($after: ID) { products(first: 5, after: $after) { items { id } nextCursor } }', { after: String(last - 2) });
    expect(r.data.products.items).toHaveLength(2);
    expect(r.data.products.nextCursor).toBeNull();
  });
  it.each([[0], [101], [-5]])('refuses a page size of %s', async (n) => {
    expect(code(await gql(app, 'query($n: Int!) { products(first: $n) { items { id } } }', { n }))).toBe('BAD_USER_INPUT');
  });
});

describe('caching in Redis must never show a wrong stock figure', () => {
  const STOCK = 'query($id: ID!) { product(id: $id) { stock } }';
  it('shows the new stock right after a checkout (the cached copy was dropped)', async () => {
    const user = await newUser(app);
    const productId = await newProduct(app, { stock: 10 });
    expect((await gql(app, STOCK, { id: String(productId) })).data.product.stock).toBe(10);
    await placeOrder(app, user, [{ productId, quantity: 4 }]);
    expect((await gql(app, STOCK, { id: String(productId) })).data.product.stock).toBe(6);
  });
  it('serves repeat reads from Redis: the second read of a product sends no query to PostgreSQL', async () => {
    const productId = await newProduct(app);
    await gql(app, STOCK, { id: String(productId) });
    const before = app.stats.queries;
    await gql(app, STOCK, { id: String(productId) });
    expect(app.stats.queries - before).toBe(0);
  });
  it('gives the cached copy a lifetime, so a missed invalidation heals itself', async () => {
    const productId = await newProduct(app);
    await gql(app, STOCK, { id: String(productId) });
    const ttl = await app.redis.ttl(`product:${productId}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });
  it('returns null for a product that does not exist, and does not cache the gap', async () => {
    expect((await gql(app, STOCK, { id: '987654321' })).data.product).toBeNull();
    expect(await app.redis.get('product:987654321')).toBeNull();
  });
});

describe('efficiency: a list of orders must not cost a query per row', () => {
  it('loads 15 orders with their items and products in at most 6 queries', async () => {
    const user = await newUser(app);
    for (let i = 0; i < 15; i++) await placeOrder(app, user, [{ productId: await newProduct(app) }, { productId: await newProduct(app) }]);
    const before = app.stats.queries;
    const r = await gql(app, '{ me { orders(first: 20) { id items { quantity product { name } } events { type } } } }', {}, { token: user.token });
    expect(r.data.me.orders).toHaveLength(15);
    expect(r.data.me.orders.every((o: any) => o.items.length === 2 && o.events.length === 1)).toBe(true);
    expect(app.stats.queries - before).toBeLessThanOrEqual(6); // login, orders, items, products, events (batched), not 15 x 4
  });
});

describe('who can see what', () => {
  it('shows an order only to its owner; to anyone else it does not exist', async () => {
    const [a, b] = [await newUser(app), await newUser(app)];
    const orderId = await placeOrder(app, a, [{ productId: await newProduct(app) }]);
    const Q = 'query($id: ID!) { order(id: $id) { id } }';
    expect((await gql(app, Q, { id: orderId }, { token: a.token })).data.order.id).toBe(orderId);
    expect((await gql(app, Q, { id: orderId }, { token: b.token })).data.order).toBeNull();
    expect((await gql(app, Q, { id: 'nonsense' }, { token: a.token })).data.order).toBeNull();
    expect(code(await gql(app, Q, { id: orderId }))).toBe('UNAUTHENTICATED');
  });
  it('lists only the caller\'s orders in `me`', async () => {
    const [a, b] = [await newUser(app), await newUser(app)];
    await placeOrder(app, a, [{ productId: await newProduct(app) }]);
    expect((await gql(app, '{ me { orders { id } } }', {}, { token: b.token })).data.me.orders).toEqual([]);
  });
  it('returns null for `me` when nobody is logged in, without an error', async () => {
    const r = await gql(app, '{ me { id } }');
    expect(r.errors).toBeUndefined();
    expect(r.data.me).toBeNull();
  });
  it('keeps the admin operations behind the admin key', async () => {
    const user = await newUser(app);
    const orderId = await placeOrder(app, user, [{ productId: await newProduct(app) }]);
    await advanceTo(app, orderId, 'PAID');
    const M = 'mutation($id: ID!) { markFulfilling(orderId: $id) { status } }';
    expect(code(await gql(app, M, { id: orderId }, { token: user.token }))).toBe('FORBIDDEN');
    expect(code(await gql(app, M, { id: orderId }))).toBe('FORBIDDEN');
    expect((await gql(app, M, { id: orderId }, { admin: true })).data.markFulfilling.status).toBe('FULFILLING');
  });
  it('is protected from a wrong admin key', async () => {
    const res = await fetch(`${app.url}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-key': 'guess' }, body: JSON.stringify({ query: 'mutation { markFulfilling(orderId: "00000000-0000-4000-8000-000000000000") { status } }' }) });
    expect((await res.json()).errors[0].extensions.code).toBe('FORBIDDEN');
  });
});

describe('introspection and health', () => {
  it('describes its own schema', async () => {
    const r = await gql(app, '{ __type(name: "Order") { fields { name } } }');
    expect(r.data.__type.fields.map((f: any) => f.name)).toEqual(expect.arrayContaining(['id', 'status', 'items', 'events']));
  });
  it('answers /health', async () => {
    expect(await (await fetch(`${app.url}/health`)).json()).toEqual({ status: 'ok' });
  });
  it('keeps /metrics behind the admin key', async () => {
    expect((await fetch(`${app.url}/metrics`)).status).toBe(403);
    const ok = await fetch(`${app.url}/metrics`, { headers: { 'x-admin-key': app.config.adminKey } });
    expect(ok.status).toBe(200);
    const m: any = await ok.json();
    expect(m.pool.total).toBeGreaterThan(0);
    expect(m.postgres.connections).toBeGreaterThan(0);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../src/app.js';
import { ADD, CHECKOUT, code, event, gql, newProduct, newUser, sendWebhook, startApp } from './helpers.js';

let app: App;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app.close(); });

describe('the cart lives in Redis', () => {
  it('stores the cart as a hash keyed by user, with a one-hour lifetime', async () => {
    const user = await newUser(app);
    const productId = await newProduct(app);
    await gql(app, ADD, { p: String(productId), q: 3 }, { token: user.token });
    expect(await app.redis.hgetall(`cart:${user.id}`)).toEqual({ [String(productId)]: '3' });
    const ttl = await app.redis.ttl(`cart:${user.id}`);
    expect(ttl).toBeGreaterThan(3500);
    expect(ttl).toBeLessThanOrEqual(3600);
  });

  it('restarts the lifetime each time the cart changes', async () => {
    const user = await newUser(app);
    await gql(app, ADD, { p: String(await newProduct(app)), q: 1 }, { token: user.token });
    await app.redis.expire(`cart:${user.id}`, 100);
    await gql(app, ADD, { p: String(await newProduct(app)), q: 1 }, { token: user.token });
    expect(await app.redis.ttl(`cart:${user.id}`)).toBeGreaterThan(3000);
  });

  it('survives a restart of the service (the cart is not kept in the service\'s memory)', async () => {
    const user = await newUser(app);
    const productId = await newProduct(app);
    await gql(app, ADD, { p: String(productId), q: 2 }, { token: user.token });
    const second = await startApp({ redisUrl: app.config.redisUrl });
    try {
      if (!app.config.redisUrl) return; // the in-memory stand-in is private to one instance; the CI run with real Redis checks this
      const r = await gql(second, '{ cart { items { quantity } } }', {}, { token: user.token });
      expect(r.data.cart.items).toEqual([{ quantity: 2 }]);
    } finally { await second.close(); }
  });

  it('is gone after the lifetime ends: an expired cart is an empty cart', async () => {
    const user = await newUser(app);
    await gql(app, ADD, { p: String(await newProduct(app)), q: 1 }, { token: user.token });
    await app.redis.del(`cart:${user.id}`); // what Redis does when the key expires
    expect(code(await gql(app, CHECKOUT, {}, { token: user.token }))).toBe('EMPTY_CART');
  });

  it('removes the cart key once the order is placed', async () => {
    const user = await newUser(app);
    await gql(app, ADD, { p: String(await newProduct(app)), q: 1 }, { token: user.token });
    await gql(app, CHECKOUT, {}, { token: user.token });
    expect(await app.redis.exists(`cart:${user.id}`)).toBe(0);
  });
});

describe('rate limiting in Redis', () => {
  it('allows the configured number of mutations per minute, then answers RATE_LIMITED', async () => {
    const limited = await startApp({ rateLimitPerMinute: 5, redisUrl: app.config.redisUrl });
    try {
      const user = await newUser(limited);
      const p = String(await newProduct(limited));
      const results = [];
      for (let i = 0; i < 8; i++) results.push(await gql(limited, ADD, { p, q: 1 }, { token: user.token }));
      expect(results.slice(0, 5).every((r) => !r.errors)).toBe(true);
      expect(results.slice(5).map((r) => code(r))).toEqual(['RATE_LIMITED', 'RATE_LIMITED', 'RATE_LIMITED']);
    } finally { await limited.close(); }
  });

  it('counts each customer separately', async () => {
    const limited = await startApp({ rateLimitPerMinute: 2, redisUrl: app.config.redisUrl });
    try {
      const [a, b] = [await newUser(limited), await newUser(limited)];
      const p = String(await newProduct(limited));
      await gql(limited, ADD, { p, q: 1 }, { token: a.token });
      await gql(limited, ADD, { p, q: 1 }, { token: a.token });
      expect(code(await gql(limited, ADD, { p, q: 1 }, { token: a.token }))).toBe('RATE_LIMITED');
      expect((await gql(limited, ADD, { p, q: 1 }, { token: b.token })).errors).toBeUndefined();
    } finally { await limited.close(); }
  });

  it('does not count reads against the limit', async () => {
    const limited = await startApp({ rateLimitPerMinute: 1, redisUrl: app.config.redisUrl });
    try {
      const user = await newUser(limited);
      for (let i = 0; i < 10; i++) expect((await gql(limited, '{ cart { totalCents } }', {}, { token: user.token })).errors).toBeUndefined();
    } finally { await limited.close(); }
  });

  it('gives the counter a one-minute lifetime, so the limit resets by itself', async () => {
    const limited = await startApp({ rateLimitPerMinute: 5, redisUrl: app.config.redisUrl });
    try {
      const user = await newUser(limited);
      await gql(limited, ADD, { p: String(await newProduct(limited)), q: 1 }, { token: user.token });
      const key = `rl:${user.id}:${Math.floor(Date.now() / 60_000)}`;
      const ttl = await limited.redis.ttl(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60);
    } finally { await limited.close(); }
  });
});

describe('webhook idempotency keys in Redis', () => {
  it('remembers an applied event for a day', async () => {
    const user = await newUser(app);
    const productId = await newProduct(app);
    await gql(app, ADD, { p: String(productId), q: 1 }, { token: user.token });
    const orderId = (await gql(app, CHECKOUT, {}, { token: user.token })).data.checkout.id;
    const ev = event('payment.succeeded', orderId);
    await sendWebhook(app, ev);
    const ttl = await app.redis.ttl(`webhook:${ev.id}`);
    expect(ttl).toBeGreaterThan(86_000);
    expect(ttl).toBeLessThanOrEqual(86_400);
  });
});

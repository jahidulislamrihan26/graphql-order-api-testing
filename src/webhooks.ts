import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Config } from './config.js';
import type { Db } from './db.js';
import type { RedisClient } from './redis.js';
import { invalidateProducts, transition, withTx } from './orders.js';
import type { Status } from './stateMachine.js';

/** `sha256=<hex>` of `<timestamp>.<raw body>`, the way a payment or shipping provider signs a callback. */
export function signPayload(secret: string, timestamp: number | string, rawBody: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

const reply = (res: ServerResponse, status: number, body: unknown) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
};

const readBody = (req: IncomingMessage): Promise<string> => new Promise((resolve, reject) => {
  let data = '';
  req.on('data', (c) => { data += c; if (data.length > 100_000) reject(new Error('payload too large')); });
  req.on('end', () => resolve(data));
  req.on('error', reject);
});

/** event type -> the status the order moves to, and the only status it may move from. */
const EVENTS: Record<string, { to: Status; onlyFrom?: Status }> = {
  'payment.succeeded': { to: 'PAID' },
  'payment.failed': { to: 'CANCELLED', onlyFrom: 'PENDING_PAYMENT' }, // a failure notice for an already paid order is ignored
  'shipment.shipped': { to: 'SHIPPED' },
  'shipment.delivered': { to: 'DELIVERED' },
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleWebhook(req: IncomingMessage, res: ServerResponse, ctx: { db: Db; redis: RedisClient; config: Config }): Promise<void> {
  if (req.method !== 'POST') return reply(res, 405, { error: 'POST only' });

  // 1. who is calling: signature over the exact bytes received, and a recent timestamp so a captured request cannot be replayed later
  const raw = await readBody(req).catch(() => null);
  if (raw === null) return reply(res, 413, { error: 'payload too large' });
  const timestamp = String(req.headers['x-timestamp'] ?? '');
  const signature = String(req.headers['x-signature'] ?? '');
  const expected = signPayload(ctx.config.webhookSecret, timestamp, raw);
  const valid = signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  if (!valid) return reply(res, 401, { error: 'invalid signature' });
  if (!/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > ctx.config.webhookToleranceSeconds) return reply(res, 401, { error: 'timestamp outside the allowed window' });

  // 2. what they are saying
  let event: { id?: unknown; type?: unknown; orderId?: unknown };
  try { event = JSON.parse(raw); } catch { return reply(res, 400, { error: 'body is not valid JSON' }); }
  if (typeof event.id !== 'string' || typeof event.type !== 'string' || typeof event.orderId !== 'string' || !UUID.test(event.orderId)) return reply(res, 400, { error: 'id, type and a valid orderId are required' });
  const { id, type, orderId } = event as { id: string; type: string; orderId: string };
  const rule = EVENTS[type];
  if (!rule) return reply(res, 422, { error: `unknown event type ${type}` });

  // 3. have we seen this event before? Providers retry, so the same event id must never be applied twice
  const first = await ctx.redis.set(`webhook:${id}`, '1', 'EX', 86_400, 'NX');
  if (first === null) return reply(res, 200, { status: 'duplicate' });

  try {
    const { rows } = await ctx.db.query('select status from orders where id = $1', [orderId]);
    if (!rows.length) { await ctx.redis.del(`webhook:${id}`); return reply(res, 404, { error: 'unknown order' }); }
    if (rule.onlyFrom && rows[0].status !== rule.onlyFrom) {
      await ctx.db.query('insert into webhook_events (event_id, type, order_id, outcome) values ($1, $2, $3, $4) on conflict do nothing', [id, type, orderId, 'ignored']);
      return reply(res, 200, { status: 'ignored', reason: `order is ${rows[0].status}` });
    }
    const inserted = await ctx.db.query('insert into webhook_events (event_id, type, order_id, outcome) values ($1, $2, $3, $4) on conflict do nothing returning event_id', [id, type, orderId, 'applied']);
    if (!inserted.rowCount) return reply(res, 200, { status: 'duplicate' }); // second line of defence if Redis lost the key
    try {
      const result = await withTx(ctx.db, (client) => transition(client, orderId, rule.to, type.split('.')[0], type));
      await invalidateProducts(ctx.redis, result.touchedProducts);
      return reply(res, 200, { status: 'applied', orderStatus: result.order.status });
    } catch (err) {
      const code = (err as { extensions?: { code?: string } }).extensions?.code;
      if (code === 'INVALID_TRANSITION') { // late, early or out-of-order event: acknowledge it so the provider stops retrying, change nothing
        await ctx.db.query("update webhook_events set outcome = 'ignored' where event_id = $1", [id]);
        return reply(res, 200, { status: 'ignored', reason: 'INVALID_TRANSITION' });
      }
      throw err;
    }
  } catch (err) {
    await ctx.redis.del(`webhook:${id}`); // let the provider retry a request that failed on our side
    return reply(res, 500, { error: 'internal error' });
  }
}

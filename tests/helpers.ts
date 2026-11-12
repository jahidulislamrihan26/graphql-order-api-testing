import crypto from 'node:crypto';
import { createApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import { signPayload } from '../src/webhooks.js';

export const startApp = (overrides: Partial<Config> = {}): Promise<App> => createApp({ port: 0, ...overrides }, { migrateAndSeed: false });

export interface GqlResult<T = any> { status: number; data?: T; errors?: Array<{ message: string; extensions?: { code?: string } }> }
interface Auth { token?: string; admin?: boolean }

export async function gql<T = any>(app: App, query: string, variables: Record<string, unknown> = {}, auth: Auth = {}): Promise<GqlResult<T>> {
  const res = await fetch(`${app.url}/graphql`, {
    method: 'POST',
    // what real GraphQL clients send: asks for the "GraphQL over HTTP" status codes (400 for a request that is invalid)
    headers: { 'content-type': 'application/json', accept: 'application/graphql-response+json, application/json', ...(auth.token ? { authorization: `Bearer ${auth.token}` } : {}), ...(auth.admin ? { 'x-admin-key': app.config.adminKey } : {}) },
    body: JSON.stringify({ query, variables }),
  });
  return { status: res.status, ...(await res.json()) } as GqlResult<T>;
}
/** The machine-readable error code of the first error, or undefined if the call succeeded. */
export const code = (r: GqlResult): string | undefined => r.errors?.[0]?.extensions?.code;

const rand = () => crypto.randomBytes(6).toString('hex');

/** A new customer with their own cart and orders, so no test depends on another. */
export async function newUser(app: App): Promise<{ id: number; token: string }> {
  const token = `tok-${rand()}`;
  const { rows } = await app.db.query('insert into users (email, token) values ($1, $2) returning id', [`u-${rand()}@test.dev`, token]);
  return { id: rows[0].id, token };
}

/** A new product with exactly the stock and price a test needs. */
export async function newProduct(app: App, o: { stock?: number; priceCents?: number } = {}): Promise<number> {
  const { rows } = await app.db.query('insert into products (name, price_cents, stock) values ($1, $2, $3) returning id', [`Test product ${rand()}`, o.priceCents ?? 1000, o.stock ?? 100]);
  return rows[0].id;
}
export const stockOf = async (app: App, productId: number): Promise<number> => (await app.db.query('select stock from products where id = $1', [productId])).rows[0].stock;

export const ADD = 'mutation($p: ID!, $q: Int!) { addToCart(productId: $p, quantity: $q) { totalCents items { quantity product { id } } } }';
export const CHECKOUT = 'mutation { checkout { id status totalCents items { quantity unitPriceCents product { id } } } }';
export const CANCEL = 'mutation($id: ID!) { cancelOrder(orderId: $id) { id status } }';
export const ORDER = 'query($id: ID!) { order(id: $id) { id status totalCents events { type fromStatus toStatus source } items { quantity unitPriceCents } } }';

/** Adds the products to the customer's cart and checks out. Returns the new order's id. */
export async function placeOrder(app: App, user: { token: string }, lines: Array<{ productId: number; quantity?: number }>): Promise<string> {
  for (const l of lines) {
    const added = await gql(app, ADD, { p: String(l.productId), q: l.quantity ?? 1 }, { token: user.token });
    if (added.errors) throw new Error(`addToCart failed: ${added.errors[0].message}`);
  }
  const res = await gql(app, CHECKOUT, {}, { token: user.token });
  if (res.errors) throw new Error(`checkout failed: ${res.errors[0].message}`);
  return res.data.checkout.id;
}

export interface WebhookOptions { secret?: string; timestamp?: number; rawBody?: string; signature?: string; omitSignature?: boolean }
/** Sends a signed callback the way a payment or shipping provider would. */
export async function sendWebhook(app: App, event: Record<string, unknown>, o: WebhookOptions = {}): Promise<{ status: number; body: any }> {
  const raw = o.rawBody ?? JSON.stringify(event);
  const timestamp = o.timestamp ?? Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-timestamp': String(timestamp) };
  if (!o.omitSignature) headers['x-signature'] = o.signature ?? signPayload(o.secret ?? app.config.webhookSecret, timestamp, raw);
  const res = await fetch(`${app.url}/webhooks/events`, { method: 'POST', headers, body: raw });
  return { status: res.status, body: await res.json().catch(() => null) };
}
export const event = (type: string, orderId: string, id = `evt-${rand()}`) => ({ id, type, orderId });

/** Moves an order forward the way production would: payment, then the warehouse, then the carrier. */
export async function advanceTo(app: App, orderId: string, target: 'PAID' | 'FULFILLING' | 'SHIPPED' | 'DELIVERED'): Promise<void> {
  const steps = ['PAID', 'FULFILLING', 'SHIPPED', 'DELIVERED'];
  for (const step of steps.slice(0, steps.indexOf(target) + 1)) {
    if (step === 'PAID') expectOk(await sendWebhook(app, event('payment.succeeded', orderId)));
    if (step === 'FULFILLING') { const r = await gql(app, 'mutation($id: ID!) { markFulfilling(orderId: $id) { status } }', { id: orderId }, { admin: true }); if (r.errors) throw new Error(r.errors[0].message); }
    if (step === 'SHIPPED') expectOk(await sendWebhook(app, event('shipment.shipped', orderId)));
    if (step === 'DELIVERED') expectOk(await sendWebhook(app, event('shipment.delivered', orderId)));
  }
}
function expectOk(r: { status: number; body: any }) {
  if (r.status !== 200 || r.body?.status !== 'applied') throw new Error(`webhook not applied: ${r.status} ${JSON.stringify(r.body)}`);
}

export const statusOf = async (app: App, orderId: string): Promise<string> => (await app.db.query('select status from orders where id = $1', [orderId])).rows[0].status;

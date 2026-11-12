// k6 load test of the order service: GraphQL browsing and shopper journeys with signed payment webhooks,
// plus a monitor that samples PostgreSQL, Redis and the connection pool while the load runs.
//
//   k6 run -e PROFILE=ci load/orders.js            short run, used in CI
//   k6 run -e PROFILE=load load/orders.js          expected traffic, about 5 minutes
//   k6 run -e PROFILE=stress load/orders.js        ramp until it hurts
//
// Needs customers load-token-1 ... load-token-N (npm run load:seed) and the service running (npm start).
import http from 'k6/http';
import crypto from 'k6/crypto';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE = __ENV.BASE || 'http://127.0.0.1:4000';
const ADMIN_KEY = __ENV.ADMIN_KEY || 'admin-secret';
const SECRET = __ENV.WEBHOOK_SECRET || 'whsec_test_secret';
const USERS = Number(__ENV.USERS || 400);
const PROFILE = __ENV.PROFILE || 'ci';
const PRODUCTS = 200;

// ---- what is measured beyond k6's own numbers
const journeyOk = new Rate('journey_correct');            // every step of a shopper journey did what it should
const ordersPlaced = new Counter('orders_placed');
const webhooksApplied = new Counter('webhooks_applied');
const pgConnections = new Trend('pg_connections');
const pgActive = new Trend('pg_active_queries');
const poolWaiting = new Trend('pool_waiting_requests');
const redisOps = new Trend('redis_ops_per_sec');
const redisMemKb = new Trend('redis_memory_kb');
const redisHitRatio = new Trend('redis_hit_ratio');
const serverRssMb = new Trend('server_rss_mb');
const serverQueries = new Trend('server_queries_total');

// ---- load profiles: arrival rate (requests that keep coming even when the service slows) for browsing, and shoppers for journeys
const PROFILES = {
  ci: { duration: '60s', browseRate: 60, shoppers: 15 },
  load: { duration: '5m', browseRate: 150, shoppers: 40 },
  stress: { duration: '6m', browseRate: 150, shoppers: 40, ramp: [100, 250, 400, 550, 700, 850] },
};
const P = PROFILES[PROFILE];

const browseScenario = P.ramp
  ? { executor: 'ramping-arrival-rate', exec: 'browse', startRate: 20, timeUnit: '1s', preAllocatedVUs: 200, maxVUs: 1500, stages: P.ramp.map((r) => ({ target: r, duration: '1m' })) }
  : { executor: 'constant-arrival-rate', exec: 'browse', rate: P.browseRate, timeUnit: '1s', duration: P.duration, preAllocatedVUs: 50, maxVUs: 400 };

export const options = {
  scenarios: {
    browse: browseScenario,
    journey: { executor: 'constant-vus', exec: 'journey', vus: P.shoppers, duration: P.ramp ? '6m' : P.duration },
    monitor: { executor: 'constant-vus', exec: 'monitor', vus: 1, duration: P.ramp ? '6m' : P.duration },
  },
  thresholds: {
    'http_req_duration{scenario:browse}': ['p(95)<250', 'p(99)<600'],
    'http_req_duration{scenario:journey}': ['p(95)<1000'],
    http_req_failed: ['rate<0.01'],
    journey_correct: ['rate>0.99'],
    checks: ['rate>0.99'],
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const gql = (query, variables, token, tags) => http.post(`${BASE}/graphql`, JSON.stringify({ query, variables }), {
  headers: Object.assign({}, JSON_HEADERS, token ? { Authorization: `Bearer ${token}` } : {}),
  tags,
});
const rnd = (n) => 1 + Math.floor(Math.random() * n);
const noErrors = (res) => { try { return !JSON.parse(res.body).errors; } catch (e) { return false; } };

// ---------------------------------------------------------------------------------------------------------------- browsing
export function browse() {
  if (Math.random() < 0.3) {
    const res = gql('query($after: ID) { products(first: 20, after: $after) { items { id name priceCents stock } nextCursor } }', { after: String(rnd(150)) }, null, { name: 'products_page' });
    check(res, { 'product list ok': (r) => r.status === 200 && noErrors(r) });
  } else {
    // most reads are product details, which the service answers from Redis
    const res = gql('query($id: ID!) { product(id: $id) { id name priceCents stock } }', { id: String(rnd(PRODUCTS)) }, null, { name: 'product_detail' });
    check(res, { 'product detail ok': (r) => r.status === 200 && noErrors(r) });
  }
}

// ----------------------------------------------------------------------------------------------------- one shopper's journey
function signedWebhook(type, orderId) {
  const id = `load-${__VU}-${__ITER}-${type}-${Date.now()}`;
  const body = JSON.stringify({ id, type, orderId });
  const ts = Math.floor(Date.now() / 1000);
  const signature = 'sha256=' + crypto.hmac('sha256', SECRET, `${ts}.${body}`, 'hex');
  return http.post(`${BASE}/webhooks/events`, body, { headers: { 'Content-Type': 'application/json', 'x-timestamp': String(ts), 'x-signature': signature }, tags: { name: 'webhook' } });
}

export function journey() {
  const token = `load-token-${(__VU % USERS) + 1}`;
  const a = rnd(PRODUCTS);
  const b = ((a + rnd(PRODUCTS - 1)) % PRODUCTS) + 1;
  let ok = true;

  const add1 = gql('mutation($p: ID!, $q: Int!) { addToCart(productId: $p, quantity: $q) { totalCents } }', { p: String(a), q: 1 + (__ITER % 3) }, token, { name: 'add_to_cart' });
  ok = check(add1, { 'add to cart ok': (r) => r.status === 200 && noErrors(r) }) && ok;
  const add2 = gql('mutation($p: ID!, $q: Int!) { addToCart(productId: $p, quantity: $q) { totalCents } }', { p: String(b), q: 1 }, token, { name: 'add_to_cart' });
  ok = check(add2, { 'second add ok': (r) => r.status === 200 && noErrors(r) }) && ok;

  const cart = gql('{ cart { totalCents items { quantity product { priceCents } } } }', {}, token, { name: 'cart' });
  ok = check(cart, { 'cart total adds up': (r) => { const c = JSON.parse(r.body).data.cart; return c.totalCents === c.items.reduce((s, i) => s + i.quantity * i.product.priceCents, 0); } }) && ok;
  sleep(0.5);

  const co = gql('mutation { checkout { id status totalCents items { quantity unitPriceCents } } }', {}, token, { name: 'checkout' });
  const placed = check(co, {
    'checkout ok': (r) => r.status === 200 && noErrors(r),
    'order is PENDING_PAYMENT': (r) => JSON.parse(r.body).data.checkout.status === 'PENDING_PAYMENT',
    'order total adds up': (r) => { const o = JSON.parse(r.body).data.checkout; return o.totalCents === o.items.reduce((s, i) => s + i.quantity * i.unitPriceCents, 0); },
  });
  ok = placed && ok;
  if (!placed) { journeyOk.add(false); return; }
  ordersPlaced.add(1);
  const orderId = JSON.parse(co.body).data.checkout.id;

  const hook = signedWebhook('payment.succeeded', orderId);
  const applied = check(hook, { 'payment webhook applied': (r) => r.status === 200 && JSON.parse(r.body).status === 'applied' });
  if (applied) webhooksApplied.add(1);
  ok = applied && ok;

  const order = gql('query($id: ID!) { order(id: $id) { status } }', { id: orderId }, token, { name: 'order' });
  ok = check(order, { 'order is PAID': (r) => JSON.parse(r.body).data.order.status === 'PAID' }) && ok;

  journeyOk.add(ok);
  sleep(1);
}

// ----------------------------------------------------------------------------------------------------------------- monitor
export function monitor() {
  const res = http.get(`${BASE}/metrics`, { headers: { 'x-admin-key': ADMIN_KEY }, tags: { name: 'metrics' } });
  if (res.status === 200) {
    const m = JSON.parse(res.body);
    if (m.postgres) { pgConnections.add(m.postgres.connections); pgActive.add(m.postgres.active); }
    if (m.pool) poolWaiting.add(m.pool.waiting);
    if (m.redis) {
      redisOps.add(m.redis.opsPerSec || 0);
      redisMemKb.add(m.redis.usedMemoryKb || 0);
      const total = (m.redis.keyspaceHits || 0) + (m.redis.keyspaceMisses || 0);
      if (total > 0) redisHitRatio.add((m.redis.keyspaceHits || 0) / total);
    }
    if (m.process) serverRssMb.add(m.process.rssMb);
    serverQueries.add(m.queries);
  }
  sleep(5);
}

// ------------------------------------------------------------------------------------------------------------- end of run
export function handleSummary(data) {
  const pick = (name, stat) => (data.metrics[name] && data.metrics[name].values ? data.metrics[name].values[stat] : null);
  const summary = {
    profile: PROFILE,
    date: new Date().toISOString(),
    requests: pick('http_reqs', 'count'),
    requestsPerSecond: pick('http_reqs', 'rate'),
    failedRate: pick('http_req_failed', 'rate'),
    checksRate: pick('checks', 'rate'),
    journeyCorrectRate: pick('journey_correct', 'rate'),
    ordersPlaced: pick('orders_placed', 'count'),
    webhooksApplied: pick('webhooks_applied', 'count'),
    latencyMs: {
      browse: { p50: pick('http_req_duration{scenario:browse}', 'med'), p95: pick('http_req_duration{scenario:browse}', 'p(95)'), p99: pick('http_req_duration{scenario:browse}', 'p(99)') },
      journey: { p50: pick('http_req_duration{scenario:journey}', 'med'), p95: pick('http_req_duration{scenario:journey}', 'p(95)'), p99: pick('http_req_duration{scenario:journey}', 'p(99)') },
    },
    resources: {
      pgConnectionsMax: pick('pg_connections', 'max'), pgActiveMax: pick('pg_active_queries', 'max'), poolWaitingMax: pick('pool_waiting_requests', 'max'),
      redisOpsPerSecMax: pick('redis_ops_per_sec', 'max'), redisMemoryKbMax: pick('redis_memory_kb', 'max'), redisHitRatioAvg: pick('redis_hit_ratio', 'avg'),
      serverRssMbMax: pick('server_rss_mb', 'max'),
    },
    thresholds: Object.keys(data.metrics).reduce((acc, k) => { const t = data.metrics[k].thresholds; if (t) acc[k] = Object.keys(t).map((expr) => ({ expr, ok: t[expr].ok })); return acc; }, {}),
  };
  return { 'reports/load-summary.json': JSON.stringify(summary, null, 2), stdout: '\nLoad test finished: see reports/load-summary.json\n' };
}

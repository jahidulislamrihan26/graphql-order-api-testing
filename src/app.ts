import http from 'node:http';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { AddressInfo } from 'node:net';
import { createSchema, createYoga } from 'graphql-yoga';
import { GraphQLError, type ValidationRule } from 'graphql';
import { loadConfig, type Config } from './config.js';
import { createPool, migrate, seed, type Db } from './db.js';
import { createRedis, type RedisClient } from './redis.js';
import { typeDefs } from './schema.js';
import { createLoaders, resolvers, type Context } from './resolvers.js';
import { depthLimit } from './depthLimit.js';
import { handleWebhook } from './webhooks.js';
import { fault } from './faults.js';

export interface App {
  config: Config;
  db: Db;
  redis: RedisClient;
  url: string;
  stats: { queries: number };
  close(): Promise<void>;
}

/** Starts the service. `overrides` lets a test start an instance with, for example, a tiny rate limit. */
export async function createApp(overrides: Partial<Config> = {}, options: { migrateAndSeed?: boolean } = {}): Promise<App> {
  const config = loadConfig(overrides);
  const db = createPool(config.databaseUrl, config.dbPoolMax);
  const redis = await createRedis(config.redisUrl);
  const stats = { queries: 0 };
  // count every query sent to PostgreSQL, so a test can assert that a request does not cause a query per row
  db.on('connect', (client) => {
    const original = client.query.bind(client) as (...args: unknown[]) => unknown;
    (client as unknown as { query: unknown }).query = (...args: unknown[]) => { stats.queries++; return original(...args); };
  });
  if (options.migrateAndSeed ?? true) { await migrate(db); await seed(db); }

  const yoga = createYoga<{ req: http.IncomingMessage }, Context>({
    schema: createSchema({ typeDefs, resolvers: resolvers as never }),
    graphqlEndpoint: '/graphql',
    landingPage: false,
    logging: false,
    // Domain errors (INVALID_TRANSITION, INSUFFICIENT_STOCK, ...) carry a code and are meant for the client. Anything else is a bug or a
    // failure inside the service, and must not leak details, so it is replaced by a generic message.
    maskedErrors: {
      maskError: (error: unknown, message: string) => {
        const original = (error as { originalError?: { name?: string; extensions?: { code?: string }; message?: string } }).originalError;
        // GraphQL errors are meant for the client: either GraphQL itself rejected the request (syntax, validation, variable values),
        // or the service threw one of its own domain errors (INVALID_TRANSITION, ...). They pass through.
        if (!original || original.name === 'GraphQLError' || fault('leak-errors')) return error as Error;
        // Anything else is a bug or a failure inside the service (a database error, a TypeError): hide the details.
        return new GraphQLError(message, { extensions: { code: 'INTERNAL_SERVER_ERROR' } });
      },
    },
    plugins: [{ onValidate: ({ addValidationRule }: { addValidationRule: (rule: ValidationRule) => void }) => { if (!fault('no-depth-limit')) addValidationRule(depthLimit(config.maxQueryDepth)); } }],
    context: async ({ request }) => {
      const auth = request.headers.get('authorization') ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      let user = null;
      if (token) {
        const { rows } = await db.query('select id, email from users where token = $1', [token]);
        user = rows[0] ?? null;
      }
      return { db, redis, config, user, isAdmin: request.headers.get('x-admin-key') === config.adminKey, loaders: createLoaders(db) };
    },
  });

  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    try {
      if (path === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); return void res.end('{"status":"ok"}'); }
      if (path.startsWith('/webhooks/')) return await handleWebhook(req, res, { db, redis, config });
      if (path === '/metrics') return await metrics(req, res, { db, redis, config, stats });
      return void (await (yoga as unknown as (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>)(req, res));
    } catch {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"internal error"}');
    }
  });
  await new Promise<void>((resolve) => server.listen(config.port, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    config, db, redis, stats, url: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await redis.quit().catch(() => undefined);
      await db.end();
    },
  };
}

const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();

/** Resource figures for the load tests: connection pool, PostgreSQL and Redis. Needs the admin key. */
async function metrics(req: http.IncomingMessage, res: http.ServerResponse, ctx: { db: Db; redis: RedisClient; config: Config; stats: { queries: number } }): Promise<void> {
  if (req.headers['x-admin-key'] !== ctx.config.adminKey) { res.writeHead(403); return void res.end(); }
  const out: Record<string, unknown> = {
    pool: { total: ctx.db.totalCount, idle: ctx.db.idleCount, waiting: ctx.db.waitingCount },
    queries: ctx.stats.queries,
    process: { rssMb: Math.round(process.memoryUsage().rss / 1048576), heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1048576), cpuMs: Math.round((process.cpuUsage().user + process.cpuUsage().system) / 1000) },
    eventLoopLagMs: { p50: +(loop.percentile(50) / 1e6).toFixed(2), p99: +(loop.percentile(99) / 1e6).toFixed(2), max: +(loop.max / 1e6).toFixed(2) },
  };
  loop.reset();
  try {
    const { rows } = await ctx.db.query(`select (select count(*)::int from pg_stat_activity where datname = current_database()) as connections,
      (select count(*)::int from pg_stat_activity where datname = current_database() and state = 'active') as active,
      d.xact_commit, d.xact_rollback, d.deadlocks, d.blks_hit, d.blks_read from pg_stat_database d where d.datname = current_database()`);
    out.postgres = rows[0];
  } catch { out.postgres = null; }
  try {
    const info = await ctx.redis.info();
    const pick = (k: string) => Number(/^([^:]+):(.*)$/m.exec(info.split('\n').find((l) => l.startsWith(k + ':')) ?? '')?.[2]);
    out.redis = { usedMemoryKb: Math.round(pick('used_memory') / 1024), connectedClients: pick('connected_clients'), opsPerSec: pick('instantaneous_ops_per_sec'), keyspaceHits: pick('keyspace_hits'), keyspaceMisses: pick('keyspace_misses') };
  } catch { out.redis = null; }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(out));
}

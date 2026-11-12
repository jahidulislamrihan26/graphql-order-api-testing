// Runs the whole service on a laptop with nothing installed: a real PostgreSQL (embedded-postgres) and an in-memory Redis stand-in.
// For numbers that mean anything about Redis, start a real one (docker compose up -d) and set REDIS_URL.
import { createApp } from '../src/app.js';
import { startEmbeddedPostgres } from './embeddedPostgres.js';

const pg = await startEmbeddedPostgres();
process.env.DATABASE_URL = pg.url;

const app = await createApp({ port: Number(process.env.PORT ?? 4000) });
console.log(`Order service on ${app.url} (PostgreSQL: ${pg.url}, Redis: ${app.config.redisUrl ?? 'in-memory stand-in'})`);

const shutdown = async () => {
  await app.close().catch(() => undefined);
  await pg.stop();
  process.exit(0);
};
for (const s of ['SIGINT', 'SIGTERM'] as const) process.on(s, () => void shutdown());

// Runs the whole service on a laptop with nothing installed: a real PostgreSQL (embedded-postgres) and an in-memory Redis stand-in.
// For numbers that mean anything about Redis, start a real one (docker compose up -d) and set REDIS_URL.
import EmbeddedPostgres from 'embedded-postgres';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createApp } from '../src/app.js';

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address() as net.AddressInfo; probe.close(() => resolve(port)); });
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orders-dev-'));
const port = await freePort();
const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port, persistent: false, onLog: () => undefined, onError: () => undefined });
await pg.initialise();
await pg.start();
await pg.createDatabase('shop');
process.env.DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${port}/shop`;

const app = await createApp({ port: Number(process.env.PORT ?? 4000) });
console.log(`Order service on ${app.url} (PostgreSQL on port ${port}, Redis: ${app.config.redisUrl ?? 'in-memory stand-in'})`);

const shutdown = async () => {
  await app.close().catch(() => undefined);
  try {
    const pid = fs.readFileSync(path.join(dir, 'postmaster.pid'), 'utf8').split('\n')[0].trim();
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore' }); else await pg.stop();
  } catch { /* already gone */ }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(0);
};
for (const s of ['SIGINT', 'SIGTERM'] as const) process.on(s, () => void shutdown());

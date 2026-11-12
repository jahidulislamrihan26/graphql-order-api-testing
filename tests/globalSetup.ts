// Gives the suite a real PostgreSQL. In CI (or with docker compose) DATABASE_URL points at a server that is already running;
// on a laptop with no database the suite starts a real PostgreSQL itself (the embedded-postgres package) and stops it afterwards.
import EmbeddedPostgres from 'embedded-postgres';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { createPool, migrate, seed } from '../src/db.js';

/** A port nobody is using right now, so two runs in a row (or a leftover server) can never collide. */
const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address() as net.AddressInfo; probe.close(() => resolve(port)); });
});

export default async function setup() {
  let embedded: EmbeddedPostgres | undefined;
  let dir = '';
  if (!process.env.DATABASE_URL) {
    const port = await freePort();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orders-pg-'));
    embedded = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port, persistent: false, onLog: () => undefined, onError: () => undefined });
    await embedded.initialise();
    await embedded.start();
    await embedded.createDatabase('shop');
    process.env.DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${port}/shop`;
  }
  const db = createPool(process.env.DATABASE_URL);
  await migrate(db);
  await seed(db);
  await db.end();

  return async () => {
    if (!embedded) return;
    if (process.platform === 'win32') {
      // On Windows the server's helper processes can outlive a normal stop. The database is a throwaway, so end the whole process tree.
      try {
        const postmasterPid = fs.readFileSync(path.join(dir, 'postmaster.pid'), 'utf8').split('\n')[0].trim();
        spawnSync('taskkill', ['/PID', postmasterPid, '/T', '/F'], { stdio: 'ignore' });
      } catch { await embedded.stop().catch(() => undefined); }
    } else {
      await embedded.stop();
    }
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
}

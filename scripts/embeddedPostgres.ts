// A real, throwaway PostgreSQL for laptops with no database installed (the embedded-postgres package). Used by the test suite,
// the local dev script and the mutation runner, so starting and stopping it is written once.
import EmbeddedPostgres from 'embedded-postgres';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/** A port nobody is using right now, so two runs in a row (or a leftover server) can never collide. */
const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address() as net.AddressInfo; probe.close(() => resolve(port)); });
});

export async function startEmbeddedPostgres(): Promise<{ url: string; stop: () => Promise<void> }> {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orders-pg-'));
  const server = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port, persistent: false, onLog: () => undefined, onError: () => undefined });
  await server.initialise();
  await server.start();
  await server.createDatabase('shop');

  const stop = async () => {
    if (process.platform === 'win32') {
      // On Windows the server's helper processes can outlive a normal stop. The database is a throwaway, so end the whole process tree.
      try {
        const postmasterPid = fs.readFileSync(path.join(dir, 'postmaster.pid'), 'utf8').split('\n')[0].trim();
        spawnSync('taskkill', ['/PID', postmasterPid, '/T', '/F'], { stdio: 'ignore' });
      } catch { await server.stop().catch(() => undefined); }
    } else {
      await server.stop().catch(() => undefined);
    }
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  return { url: `postgres://postgres:postgres@127.0.0.1:${port}/shop`, stop };
}

// Gives the suite a real PostgreSQL. In CI (or with docker compose) DATABASE_URL points at a server that is already running;
// on a laptop with no database the suite starts a real PostgreSQL itself (see scripts/embeddedPostgres.ts) and stops it afterwards.
import { startEmbeddedPostgres } from '../scripts/embeddedPostgres.js';
import { createPool, migrate, seed } from '../src/db.js';

export default async function setup() {
  let embedded: Awaited<ReturnType<typeof startEmbeddedPostgres>> | undefined;
  if (!process.env.DATABASE_URL) {
    embedded = await startEmbeddedPostgres();
    process.env.DATABASE_URL = embedded.url;
  }
  const db = createPool(process.env.DATABASE_URL);
  await migrate(db);
  await seed(db);
  await db.end();

  return async () => { await embedded?.stop(); };
}

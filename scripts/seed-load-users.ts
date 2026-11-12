// Creates the customers the load test logs in as: load-token-1 ... load-token-N. Safe to run more than once.
import { createPool, migrate, seed } from '../src/db.js';

const count = Number(process.argv[2] ?? process.env.LOAD_USERS ?? 400);
const db = createPool(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/shop', 2);
await migrate(db);
await seed(db);
await db.query(
  `insert into users (email, token) select 'load-' || g || '@load.test', 'load-token-' || g from generate_series(1, $1::int) g on conflict do nothing`,
  [count],
);
console.log(`${count} load-test customers ready`);
await db.end();

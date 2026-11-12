// After a load test: check that the database is still consistent. Fast responses mean little if stock or orders were corrupted
// underneath. Exits with a non-zero code and lists every violation it finds.
//   DATABASE_URL=... npx tsx scripts/verify-integrity.ts
import { createPool } from '../src/db.js';
import { runChecks } from '../src/integrityChecks.js';

const db = createPool(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/shop', 2);
const orders = (await db.query('select count(*)::int as n from orders')).rows[0].n;
const results = await runChecks(db);
await db.end();

let failed = 0;
for (const r of results) {
  if (r.violations) { failed++; console.log(`FAIL  ${r.name}: ${r.violations} violation(s), for example ${JSON.stringify(r.example)}`); }
  else console.log(`ok    ${r.name}  (${orders} orders checked)`);
}
console.log(failed ? `\n${failed} integrity check(s) failed` : '\nThe database is consistent.');
process.exitCode = failed ? 1 : 0;

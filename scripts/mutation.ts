// Mutation testing: switch on one deliberate fault at a time (src/faults.ts), run the whole test suite, and record whether it noticed.
//   killed   = at least one test failed: the suite caught the fault
//   survived = every test passed with the fault switched on: a gap in the tests
// Usage: npx tsx scripts/mutation.ts [fault-name ...]      Writes docs/mutation-report.md and reports/mutation.json
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { FAULTS } from '../src/faults.js';
import { startEmbeddedPostgres } from './embeddedPostgres.js';

const ROOT = path.join(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'reports', 'mutation');
fs.mkdirSync(OUT, { recursive: true });
const vitest = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');

interface Run { exit: number; failed: string[]; total: number }

function runSuite(fault: string): Run {
  const file = path.join(OUT, `${fault || 'baseline'}.json`);
  fs.rmSync(file, { force: true });
  const r = spawnSync(process.execPath, [vitest, 'run', '--bail=1', '--reporter=json', `--outputFile=${file}`], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, FAULT: fault, CI: '' }, maxBuffer: 64 * 1024 * 1024,
  });
  let failed: string[] = [];
  let total = 0;
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    total = json.numTotalTests;
    failed = json.testResults.flatMap((f: any) => f.assertionResults.filter((a: any) => a.status === 'failed').map((a: any) => `${path.basename(f.name)}: ${a.fullName}`));
  } catch { /* the run crashed before it wrote a report */ }
  return { exit: r.status ?? 1, failed, total };
}

// one throwaway PostgreSQL for the whole run (CI provides its own through DATABASE_URL)
const embedded = process.env.DATABASE_URL ? undefined : await startEmbeddedPostgres();
if (embedded) process.env.DATABASE_URL = embedded.url;

const only = process.argv.slice(2);
const list = FAULTS.filter(([name]) => !only.length || only.includes(name));

const baseline = runSuite('');
if (baseline.exit !== 0) {
  await embedded?.stop(); console.error('The suite fails with no fault switched on. Fix that first.', baseline.failed); process.exit(2); }
console.log(`baseline (no fault): ${baseline.total} tests pass, as required\n`);

const results = [];
for (const [name, description] of list) {
  const run = runSuite(name);
  const killed = run.exit !== 0;
  results.push({ fault: name, description, killed, firstCatch: run.failed[0] ?? (killed ? 'the run itself failed' : null) });
  console.log(`${killed ? 'KILLED  ' : 'SURVIVED'}  ${name.padEnd(28)} ${description}${run.failed[0] ? `\n          caught by: ${run.failed[0]}` : ''}`);
}

const killedCount = results.filter((r) => r.killed).length;
const score = Math.round((killedCount / results.length) * 100);
console.log(`\nMutation score: ${killedCount}/${results.length} (${score}%)`);

const md = [
  '# Mutation testing report', '',
  'A test suite that passes proves little unless it would fail when the service is wrong. This report measures exactly that.', '',
  `**Method.** The service contains ${FAULTS.length} deliberate faults ([src/faults.ts](../src/faults.ts)), each off unless \`FAULT=<name>\` is set. For every fault the whole suite (${baseline.total} tests) is run with that one fault switched on. A fault is *killed* if a test fails, and *survives* if every test still passes (a gap in the tests). The suite passes with no fault switched on.`, '',
  `**Result: ${killedCount} of ${results.length} faults killed (${score}%).**`, '',
  '| # | Injected fault | Result | First test to catch it |', '|---|---|---|---|',
  ...results.map((r, i) => `| ${i + 1} | ${r.description} | ${r.killed ? 'Killed' : '**Survived**'} | ${r.firstCatch ? r.firstCatch.replace(/\|/g, '\\|') : 'none'} |`),
  '', '## Reproduce', '```bash', 'npm run mutation', '```', 'Takes about 10 minutes. Start PostgreSQL yourself (docker compose up -d) or let the suite start an embedded one.', '',
].join('\n');
fs.writeFileSync(path.join(ROOT, 'docs', 'mutation-report.md'), md);
fs.writeFileSync(path.join(ROOT, 'reports', 'mutation.json'), JSON.stringify({ date: new Date().toISOString(), killed: killedCount, total: results.length, score, results }, null, 2));
await embedded?.stop();
process.exitCode = killedCount === results.length ? 0 : 1; // let the process end by itself (no process.exit) so cleanup hooks run

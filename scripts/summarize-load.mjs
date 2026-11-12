// Turns reports/load-summary.json into a short Markdown table (printed to stdout; CI appends it to the job summary).
import fs from 'node:fs';

const s = JSON.parse(fs.readFileSync(process.argv[2] ?? 'reports/load-summary.json', 'utf8'));
const ms = (v) => (v == null ? 'n/a' : `${v < 10 ? v.toFixed(1) : Math.round(v)} ms`);
const pct = (v) => (v == null ? 'n/a' : `${(v * 100).toFixed(2)}%`);
const allOk = Object.values(s.thresholds).flat().every((t) => t.ok);

console.log(`## Load test: ${s.profile} profile\n`);
console.log(`**${allOk ? 'All targets met' : 'A target was missed'}**: ${s.requests} requests at ${s.requestsPerSecond.toFixed(0)} per second, ${s.ordersPlaced} orders placed and paid, ${pct(s.failedRate)} failed.\n`);
console.log('| | p50 | p95 | p99 |', '\n|---|---|---|---|');
console.log(`| Browsing (product list and detail) | ${ms(s.latencyMs.browse.p50)} | ${ms(s.latencyMs.browse.p95)} | ${ms(s.latencyMs.browse.p99)} |`);
console.log(`| Shopper journey (cart, checkout, payment webhook, order) | ${ms(s.latencyMs.journey.p50)} | ${ms(s.latencyMs.journey.p95)} | ${ms(s.latencyMs.journey.p99)} |\n`);
console.log('| Resource | Highest value seen |', '\n|---|---|');
const r = s.resources;
console.log(`| PostgreSQL connections | ${r.pgConnectionsMax} |\n| PostgreSQL queries running at once | ${r.pgActiveMax} |\n| Requests waiting for a database connection | ${r.poolWaitingMax} |`);
console.log(`| Redis operations per second | ${r.redisOpsPerSecMax} |\n| Redis cache hit ratio (average) | ${pct(r.redisHitRatioAvg)} |\n| Redis memory | ${r.redisMemoryKbMax} KB |\n| Service memory (RSS) | ${r.serverRssMbMax} MB |\n`);
console.log(`Journeys that did everything correctly: ${pct(s.journeyCorrectRate)}.`);

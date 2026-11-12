// Turns reports/load-summary.json into a short Markdown report (printed to stdout; CI appends it to the job summary).
import fs from 'node:fs';

const s = JSON.parse(fs.readFileSync(process.argv[2] ?? 'reports/load-summary.json', 'utf8'));
const ms = (v) => (v == null ? 'n/a' : `${v < 10 ? v.toFixed(1) : Math.round(v)} ms`);
const pct = (v) => (v == null ? 'n/a' : `${(v * 100).toFixed(2)}%`);
const num = (v) => (v == null ? 'n/a' : Math.round(v));
const stress = s.profile === 'stress';
const allOk = Object.values(s.thresholds).flat().every((t) => t.ok);

console.log(`## Load test: ${s.profile} profile\n`);
console.log(stress
  ? `The stress profile keeps raising the traffic to find the limit, so it measures instead of pass or fail. ${s.requests} requests, ${s.ordersPlaced} orders placed and paid, ${pct(s.failedRate)} failed overall.\n`
  : `**${allOk ? 'All targets met' : 'A target was missed'}**: ${s.requests} requests at ${num(s.requestsPerSecond)} per second, ${s.ordersPlaced} orders placed and paid, ${pct(s.failedRate)} failed.\n`);

if (stress && s.stages.length) {
  console.log('| Step | Browse requests offered per second | Requests per second achieved | Browse p95 | Browse p99 | Journey p95 | Failed |', '\n|---|---|---|---|---|---|---|');
  let knee = null;
  for (const st of s.stages) {
    console.log(`| ${st.stage} | ${st.offeredBrowseRate} | ${num(st.achievedRequestsPerSecond)} | ${ms(st.browseP95)} | ${ms(st.browseP99)} | ${ms(st.journeyP95)} | ${pct(st.failedRate)} |`);
    if (!knee && ((st.browseP95 ?? 0) > 250 || (st.failedRate ?? 0) > 0.01)) knee = st;
  }
  console.log(knee ? `\n**First step past the targets (browse p95 under 250 ms, under 1% failed): step ${knee.stage}, ${knee.offeredBrowseRate} browse requests per second offered.**\n` : '\n**No step went past the targets.**\n');
} else {
  console.log('| | p50 | p95 | p99 |', '\n|---|---|---|---|');
  console.log(`| Browsing (product list and detail) | ${ms(s.latencyMs.browse.p50)} | ${ms(s.latencyMs.browse.p95)} | ${ms(s.latencyMs.browse.p99)} |`);
  console.log(`| Shopper journey (cart, checkout, payment webhook, order) | ${ms(s.latencyMs.journey.p50)} | ${ms(s.latencyMs.journey.p95)} | ${ms(s.latencyMs.journey.p99)} |\n`);
}
const r = s.resources;
console.log('| Resource | Highest value seen |', '\n|---|---|');
console.log(`| Service CPU (share of one core) | ${r.serverCpuPctMax == null ? 'n/a' : Math.round(r.serverCpuPctMax) + '%'} |\n| Event loop delay, p99 | ${ms(r.eventLoopLagP99MsMax)} |`);
console.log(`| PostgreSQL connections | ${r.pgConnectionsMax} |\n| PostgreSQL queries running at once | ${r.pgActiveMax} |\n| Requests waiting for a database connection | ${r.poolWaitingMax} |`);
console.log(`| Redis operations per second | ${r.redisOpsPerSecMax} |\n| Redis cache hit ratio (average) | ${pct(r.redisHitRatioAvg)} |\n| Redis memory | ${r.redisMemoryKbMax} KB |\n| Service memory (RSS) | ${r.serverRssMbMax} MB |\n`);
console.log(`Journeys that did everything correctly: ${pct(s.journeyCorrectRate)}.`);

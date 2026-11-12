# Load test report

Results of the load tests described in the [load test plan](load-test-plan.md). Run on GitHub Actions (one shared runner with the service, PostgreSQL 16, Redis 7 and k6 all on it), so the figures show behaviour and bottlenecks, not what a production server could do.

## Summary

| Question | Answer |
|---|---|
| Does it meet the targets at expected traffic? | **Yes, by a wide margin.** At 150 browse requests per second plus 40 shoppers: browsing p95 **2.0 ms** (target 250 ms), journey p95 **12 ms** (target 1,000 ms), 0% failed, 7,854 orders placed and paid |
| Did anything go wrong under load? | **No.** Every journey did everything correctly (100%) in all runs. After the one-minute run, 9 consistency checks on the database (586 orders) all passed: no oversold stock, no lost or duplicated orders |
| How much can it take? | **About 2,000 requests per second stay healthy** (browse p95 24 to 31 ms). The 250 ms target is first missed at about 2,500 achieved |
| What runs out first? | **The single Node.js process**, not PostgreSQL or Redis (below) |
| How does it fail? | It does not fail, it queues. Past the limit, latency climbs to 1.6 to 4.6 seconds with **0% errors**, so an error-rate alert would not notice |
| Does the database pool size matter? | **Yes if it is too small, no if it is bigger than needed.** 5 connections cut capacity by about 40%; 50 connections gave nothing over 20 |

## Expected traffic (`load` profile, 5 minutes)

| | p50 | p95 | p99 | Target |
|---|---|---|---|---|
| Browsing | 0.8 ms | 2.0 ms | 5.1 ms | p95 under 250 ms |
| Shopper journey (cart, checkout, payment webhook, order) | 2.6 ms | 12 ms | 41 ms | p95 under 1,000 ms |

92,185 requests at 306 per second, 7,854 orders placed and paid, 0.00% failed, all targets met. Highest values: 20 PostgreSQL connections, 6 queries running at once, 0 requests waiting for a connection, 823 Redis operations per second, 83% cache hit ratio, 172 MB memory.

## Finding the limit (`stress` profile: the browse rate climbs in six steps of one minute)

The same test with three database pool sizes. "Achieved" counts every request (browsing, journeys and webhooks).

| Step | Browse offered per second | Pool of 5: achieved, browse p95 | **Pool of 20**: achieved, browse p95 | Pool of 50: achieved, browse p95 |
|---|---|---|---|---|
| 1 | 300 | 314, 3.8 ms | **317, 1.8 ms** | 315, 2.5 ms |
| 2 | 800 | 705, 7.2 ms | **707, 2.8 ms** | 707, 2.2 ms |
| 3 | 1,500 | 1,281, 72 ms | **1,305, 7.3 ms** | 1,305, 6.5 ms |
| 4 | 2,200 | 1,602, **2,695 ms** | **1,997, 24 ms** | 1,995, 31 ms |
| 5 | 3,000 | 1,622, 2,754 ms | **2,554, 293 ms** | 2,421, 1,052 ms |
| 6 | 3,800 | 1,693, 2,706 ms | **2,833, 1,580 ms** | 2,554, 1,628 ms |
| Failed requests | | 0.00% | **0.00%** | 0.00% |
| Orders placed and paid, all correct | | 4,864 | **7,335** | 6,802 |

Highest values seen:

| | Pool of 5 | **Pool of 20** | Pool of 50 |
|---|---|---|---|
| Service CPU (share of one core) | 78% | **86%** | 78% |
| Event loop delay, p99 | 79 ms | **129 ms** | 138 ms |
| PostgreSQL connections open | 6 | **20** | 50 |
| PostgreSQL queries running at once | 3 | **3** | 2 |
| Requests waiting for a database connection | 1,506 | **1,406** | 1,262 |
| Redis operations per second | 1,521 | **2,410** | 2,267 |
| Redis cache hit ratio | 88% | **89%** | 89% |
| Service memory | 339 MB | **337 MB** | 340 MB |

## What the numbers say

1. **The limit is the Node.js process, not the database or Redis.** At the limit PostgreSQL was running only 2 or 3 queries at once (it was almost idle), and Redis was doing about 2,400 simple operations per second, a small fraction of what it can do. The service process, however, reached 78 to 86% of a core in its busiest 5-second sample (the monitor samples every 5 seconds, so short peaks were higher) and its event loop was delayed by up to 138 ms. Node runs JavaScript on one thread, so one process can use one core.
2. **Requests wait for a connection because the process is busy, not because the database is slow.** More than 1,000 requests were queued for a database connection at the limit, while PostgreSQL ran 3 queries. The connections were held while the busy event loop got round to reading the answers. That is why 50 connections gave nothing over 20.
3. **A pool that is too small does hurt.** With 5 connections the knee came a full step earlier (2,200 offered instead of 3,000) and the service topped out near 1,650 requests per second instead of 2,800, about 40% less.
4. **Overload shows as slowness, not errors.** At the top steps browse p95 was 1.6 s and journey p95 up to 4.6 s with 0% failed. A monitor that only watches the error rate would stay green while customers wait.
5. **Correctness held.** In every run all journeys (4,864 to 7,854 orders) did everything correctly, including the signed payment webhook, at saturation.

## Recommendations

| # | Recommendation | Why | Effort |
|---|---|---|---|
| 1 | **Run several instances** of the service (Node's cluster mode or several containers) behind a load balancer | One instance can use one core; the limit is that core. The carts, rate limit counters, cache and webhook de-duplication already live in Redis and PostgreSQL, so instances share no state | Low |
| 2 | **Alert on latency and on requests waiting for a connection**, not only on errors | Overload shows as slowness with no errors | Low |
| 3 | **Add load shedding**: cap requests in flight and answer 503 with `Retry-After` beyond it | A queue that grows without a limit turns a busy moment into a multi-second wait for everybody | Low |
| 4 | **Keep the database pool at about 20** and do not raise it | 5 is too small, 50 gives nothing; watch "requests waiting for a connection" if traffic grows | None |
| 5 | **Cache the product list** as well as product details | Details are served from Redis (hit ratio near 89%), but the list, 30% of browse traffic, goes to PostgreSQL every time | Low |
| 6 | **Profile the service under load** (CPU profile) to see where the cycles go, then cut it: parsing and validating each GraphQL document, JSON handling | The service is CPU-bound, so less work per request raises the limit on every instance | Medium |

## What was not measured

- **Recovery after overload.** The stress profile ends at its top step; it does not drop the load and check how fast latency returns to normal. This is the next test to add.
- **Long runs (soak).** Memory and connection growth over hours.
- **Several instances behind a load balancer**, which recommendation 1 would change.
- **A large catalogue.** 200 products and 400 customers are small; query plans could differ on millions of rows.
- **Database integrity after the stress runs.** The consistency check was added after them. It passed on the one-minute run (586 orders, 9 of 9 checks); every load run in CI now runs it.
- **Repeat runs.** Each configuration was run once on a cloud runner whose speed varies, so small differences (for example 2,554 against 2,833 requests per second between pools of 20 and 50) are noise. The large effects (the pool of 5, the knee near 2,200 to 3,000 offered) are not.

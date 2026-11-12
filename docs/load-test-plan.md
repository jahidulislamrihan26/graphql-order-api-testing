# Load test plan

How the service is load tested, what the numbers mean, and how to repeat the test. Results are in the [load test report](load-test-report.md).

## 1. Questions the test answers

1. Does the service meet its latency targets at the traffic we expect?
2. Does anything go wrong that only happens under load (wrong totals, lost orders, overselling)?
3. How much traffic can it take, and **what runs out first**: the service's CPU, the database connections, PostgreSQL, or Redis?
4. How does it behave past the limit: does it slow down gradually or fall over, and does it recover?
5. Do the settings we can change (such as the database pool size) matter?

## 2. Traffic model

Real shops are mostly browsing, with a smaller stream of shoppers who buy. The test keeps that shape.

| Traffic | Share | What a request is | Model |
|---|---|---|---|
| **Browsing** | most of the requests | the product list (30%) or a product detail (70%), no login | *Arrival rate*: requests keep coming at a fixed rate even when the service slows, like real visitors |
| **Shopper journey** | 40 shoppers at a time | add two products to the cart, read the cart, check out, send the signed payment webhook, read the order back, with think time | *Closed model*: a shopper waits for each answer, so this answers "how many shoppers can be buying at once" |
| **Monitor** | one scrape every 5 seconds | `/metrics`: connection pool, PostgreSQL, Redis, CPU, event loop, memory | Runs beside the load, never part of it |

Journeys check what they should: the cart total adds up, the order starts as `PENDING_PAYMENT`, its total equals the sum of its lines, the payment webhook is applied, and the order ends `PAID`. A fast wrong answer counts as a failure.

## 3. Targets

| Measure | Target |
|---|---|
| Browsing latency | p95 under 250 ms, p99 under 600 ms |
| Shopper journey latency | p95 under 1,000 ms |
| Failed requests | under 1% |
| Journeys that did everything correctly | over 99% |

Percentiles, not averages: an average hides the slow requests that customers notice.

## 4. Profiles

| Profile | Length | Traffic | Used for |
|---|---|---|---|
| `ci` | 1 minute | 60 browse requests per second, 15 shoppers | every push: a quick check that nothing got slower |
| `load` | 5 minutes | 150 browse requests per second, 40 shoppers | the expected-traffic test |
| `stress` | 6 minutes | the browse rate climbs in 6 steps of one minute, to 3,800 per second, with 40 shoppers | finds the limit; it measures instead of pass or fail, and each step is reported on its own |

## 5. What is measured about the system, not just the requests

| Source | Figures | Why |
|---|---|---|
| Service | CPU (share of one core), event-loop delay, memory, queries sent | Node.js runs JavaScript on one thread: a busy thread shows as CPU near 100% and a growing event-loop delay |
| Connection pool | connections open, requests waiting for a connection | the first place a database-bound service queues |
| PostgreSQL | connections, queries running at once, deadlocks | shows whether the database is the bottleneck |
| Redis | operations per second, cache hit ratio, memory | shows whether the cache is doing its job |

## 6. Setup and method

- The service, PostgreSQL 16 and Redis 7 run on one GitHub Actions runner (service containers), and k6 runs on the same machine. This is a **small, shared** environment: the load generator takes CPU from the service, so the limit it finds is lower than a dedicated server's. The numbers show behaviour and bottlenecks, not production capacity.
- 400 customers are created before the run; the catalogue has 200 products with plenty of stock, so the test measures speed and not stock-outs.
- The stress profile is run with different database pool sizes to see whether that setting is the limit.
- Run it yourself:

```bash
docker compose up -d                 # PostgreSQL and Redis
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/shop REDIS_URL=redis://localhost:6379
npm start &                          # the service on port 4000
npm run load:seed                    # the 400 customers
k6 run -e PROFILE=load load/orders.js
node scripts/summarize-load.mjs      # a readable summary of reports/load-summary.json
```

## 7. Risks to the numbers

- **Shared machine** (above): treat the limit as a lower bound.
- **Noisy neighbours**: a cloud runner's speed varies from run to run, so a single run is evidence, not proof. Compare steps within a run, and repeat before relying on a small difference.
- **A warm cache**: most product reads hit Redis after the first seconds, as in real life; the first steps of a run include warm-up.
- **Synthetic data**: 200 products and 400 customers are far smaller than a real shop. Query plans on a large catalogue could differ.

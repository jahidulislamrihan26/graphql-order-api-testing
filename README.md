# GraphQL Order API Testing: PostgreSQL, Redis and Webhooks

[![CI](https://github.com/jahidulislamrihan26/graphql-order-api-testing/actions/workflows/ci.yml/badge.svg)](https://github.com/jahidulislamrihan26/graphql-order-api-testing/actions/workflows/ci.yml) Part of the [SQA portfolio](https://github.com/jahidulislamrihan26/sqa-portfolio).

Backend testing of an online-shop order service: automated API tests in **TypeScript** for a **GraphQL** API on **PostgreSQL and Redis** (orders, checkout, signed webhooks, cancellations, returns), **load testing with k6** that shows what runs out first, and proof that the tests catch real bugs. The service is small and written for this project, so the tests can be run, broken and fixed in front of you.

## Result in one look
| | |
|---|---|
| **API tests** | **124**, TypeScript and Vitest, real HTTP calls, **real PostgreSQL and Redis in CI** (service containers) |
| **Do the tests catch bugs?** | **Yes, proven: 20 of 20 deliberately injected faults caught** ([mutation report](docs/mutation-report.md)): cancelling after shipping, unsigned or replayed webhooks, duplicate events, overselling, stale cache, cross-customer access and more |
| **Order workflows** | the whole state machine (all 64 status pairs), payment, shipping and delivery webhooks, cancellations and restocking, returns with a 30-day window, notifications, audit trail |
| **Failure scenarios** | bad signature, replay, same event 10 times at once, events early, late or out of order, payment failed after paid, a database fault half-way through a webhook, 30 customers fighting over 7 items |
| **Load** | healthy to about **2,000 requests per second** on a small shared runner; the first thing to run out is the **single Node.js process**, not PostgreSQL or Redis; a database pool of 5 costs about 40% of capacity, 50 gains nothing; overload shows as slowness with **0% errors** ([load report](docs/load-test-report.md)) |
| **Data integrity** | 9 SQL checks after the load (stock, totals, histories, notifications) pass on 586 orders; 8 more tests corrupt data on purpose to prove the checks notice |
| **Documents** | [test strategy](docs/test-strategy.md), [load test plan](docs/load-test-plan.md), [load test report](docs/load-test-report.md), [mutation report](docs/mutation-report.md) |

## What the tests found while it was being built
- Business errors such as `INVALID_TRANSITION` reached clients as `INTERNAL_SERVER_ERROR`: the error masking was too aggressive. The first test run showed it.
- A request with a wrong variable type answered **HTTP 500**, a server failure for what is a client mistake, for the same reason. Fixed so that errors raised by GraphQL itself pass through and only unexpected exceptions are hidden.
- Two of the tests were wrong themselves, and were fixed: one simulated a database fault by renaming a shared table (which would break tests running in parallel), and one expected the wrong outcome of a cancellation racing a payment (the right rule is that the order always ends cancelled, whichever request wins).

## What is tested
| File | Tests | Covers |
|---|---|---|
| `order-lifecycle.test.ts` | 12 | the state machine, a full order with its audit trail, notifications, refused moves |
| `checkout.test.ts` | 15 | cart in Redis, totals from database prices, stock taken, all-or-nothing, empty cart, login |
| `webhooks.test.ts` | 24 | signature, timestamp replay, bad input, duplicates (also 10 at once), early and late events, failed payments, a fault half-way through |
| `cancellations-and-returns.test.ts` | 20 | when an order can be cancelled, restocking, other customers' orders, the 30-day return window, completing a return |
| `concurrency.test.ts` | 6 | overselling, deadlocks, double-click, a cancellation racing a payment |
| `graphql.test.ts` | 29 | validation errors, query depth limit, pagination, Redis cache correctness, no N+1 queries, who can see what, error masking |
| `redis.test.ts` | 10 | cart storage and lifetime, rate limiting, webhook de-duplication keys |
| `integrity.test.ts` | 8 | the data checker itself: each rule is shown to notice the damage it is for |

## Run it
Needs Node 22 or newer. No database needed: the suite starts a real PostgreSQL itself (the `embedded-postgres` package) and uses an in-memory Redis stand-in. CI runs the same tests against real PostgreSQL 16 and Redis 7.
```bash
npm install
npm test                 # 124 tests in about 15 seconds
npm run typecheck
npm run mutation         # inject 20 faults one by one; every one must make a test fail (about 6 minutes)
```
With real PostgreSQL and Redis (needs Docker):
```bash
docker compose up -d
DATABASE_URL=postgres://postgres:postgres@localhost:5432/shop REDIS_URL=redis://localhost:6379 npm test
DATABASE_URL=... REDIS_URL=... npm start       # the service on :4000, GraphQL at /graphql
npm run load:seed && k6 run -e PROFILE=load load/orders.js    # needs k6
node scripts/summarize-load.mjs
```

## Layout
```
src/        the service: schema, resolvers, order state machine, webhooks, caching, rate limit, integrity checks
tests/      the API tests and their helpers (users, products, signed webhooks, orders)
load/       k6 load test with PostgreSQL and Redis measurements
scripts/    local dev server, load-test users, summary, data integrity check, mutation runner
docs/       strategy, load plan, load report, mutation report
```

## How the tests are built
- **Every test makes its own data** (its own customer and product), so tests run in parallel and never depend on each other.
- **Check the database, not only the answer.** A response that says "cancelled" proves little if the stock did not come back.
- **Expected values are worked out in the test**, never copied from the service.
- **Errors are asserted by code** (`INSUFFICIENT_STOCK`, `RATE_LIMITED`), because that is what a client acts on.
- **No retries.** A flaky test is fixed or deleted.

## Limits
- The shop is a small service written for this project, not a real company's API. Webhooks use the same signing scheme as real providers but are not tested against one.
- Load numbers come from one small shared runner (the service, databases and k6 on the same machine) and show behaviour and bottlenecks, not what a production server can do. Recovery after overload and long soak runs are not measured yet; the [report](docs/load-test-report.md) lists what was left out.
- Mobile end-to-end testing is not part of this project; the UI side is covered in the portfolio's Playwright, Cypress and Selenium projects.

## Related projects
[api-testing-newman-openapi](https://github.com/jahidulislamrihan26/api-testing-newman-openapi) (REST API testing with Postman and an OpenAPI spec) · [k6-performance-testing](https://github.com/jahidulislamrihan26/k6-performance-testing) (load, stress and soak testing of a REST shop) · [playwright-ui-automation-pom](https://github.com/jahidulislamrihan26/playwright-ui-automation-pom) (UI automation in TypeScript) · [sqa-portfolio](https://github.com/jahidulislamrihan26/sqa-portfolio) (the hub)

## License
Released under the [MIT License](LICENSE). Copyright (c) 2026 Md. Jahidul Islam Rihan.

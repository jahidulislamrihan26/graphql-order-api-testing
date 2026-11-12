# Test strategy

How this service is tested, why, and what is left out on purpose. The service is a small online-shop backend: a GraphQL API for browsing, carts, checkout, cancellations and returns, a signed webhook endpoint for payment and shipping providers, PostgreSQL for orders and stock, and Redis for carts, caching, rate limiting and webhook de-duplication.

## 1. What can go wrong, and how much it matters

Tests are planned from risk: the money and stock bugs first, the cosmetic ones last.

| Risk | If it happens | Likelihood | Where it is tested |
|---|---|---|---|
| Selling more than is in stock | Orders that cannot be fulfilled, refunds, angry customers | High under load | `concurrency.test.ts` (30 buyers, 7 items), `checkout.test.ts` |
| An order in a wrong state (shipped but cancelled, paid twice) | Money and goods out of step | High: events arrive late, twice or out of order | `order-lifecycle.test.ts`, `webhooks.test.ts` |
| A webhook applied twice or forged | Duplicate shipments, free orders | High: providers retry, attackers probe | `webhooks.test.ts` (signature, replay, duplicates, 10 at once) |
| Wrong totals | Wrong charge | Medium | `checkout.test.ts` (server-side prices, price change after checkout) |
| Stock not returned on cancel or return | Shelf shows less than exists | Medium | `cancellations-and-returns.test.ts`, `webhooks.test.ts` |
| Stale cache shows a wrong stock figure | Customers buy what is not there | Medium | `graphql.test.ts` (cache section) |
| One customer sees or changes another's order | Privacy breach | Medium | `graphql.test.ts`, `cancellations-and-returns.test.ts` |
| An expensive query takes the database down | Outage | Medium | depth limit and N+1 tests, `load/orders.js` |
| Rate limit or cart lifetime broken | Abuse, memory growth in Redis | Low to medium | `redis.test.ts` |
| Internal error details leak | Information for an attacker | Low | `graphql.test.ts` |

## 2. Layers

| Layer | What it proves | How |
|---|---|---|
| Rules | The order state machine allows exactly the legal moves (all 64 pairs of statuses) | `order-lifecycle.test.ts` |
| API behaviour | Every mutation and query does what the schema promises, including errors, with codes a client can act on | Vitest and real HTTP calls to a running instance, real PostgreSQL |
| Integration | The pieces agree: stock in PostgreSQL, cached copy in Redis, cart in Redis, events and notifications | Tests read the database and Redis directly after each action |
| Failure injection | A fault part-way through a webhook leaves nothing half-applied and the event can be retried | A database trigger that fails for one order only |
| Concurrency | Races end in a consistent state | `Promise.all` of 10 to 30 simultaneous requests |
| Load | The service holds up at expected traffic, and where it breaks first | k6 with PostgreSQL and Redis measurements |
| Test quality | The suite would catch a real defect | [Mutation testing](mutation-report.md): 20 injected faults |

## 3. Principles

- **Real PostgreSQL, real Redis in CI.** A mock database would hide the bugs that matter here: locking, constraints, transactions. On a laptop the suite starts a real PostgreSQL itself and uses an in-memory Redis stand-in; CI runs both for real.
- **Every test creates its own data** (its own customer, its own product with exactly the stock it needs). Tests run in parallel and never depend on each other.
- **Check the database, not only the response.** A response that says "cancelled" proves little if the stock did not come back.
- **Expected values are worked out in the test**, not copied from the service's answer.
- **Test the failure paths as hard as the happy path.** Webhooks that arrive twice, early, late or for orders that do not exist; payments that fail; carts that expire.
- **Name the error.** Clients act on codes such as `INVALID_TRANSITION` and `INSUFFICIENT_STOCK`, so the tests assert the code, not just "an error".

## 4. Conventions

- A test file per area; a `describe` per rule; test names are sentences that say what must be true.
- Helpers in `tests/helpers.ts` build the world (`newUser`, `newProduct`, `placeOrder`, `advanceTo`, `sendWebhook`) so a test reads as the scenario.
- A new business rule needs: a test for the rule, a test for each way it can be broken, and a fault in `src/faults.ts` if a missing check would be dangerous. Run `npm run mutation` to confirm the new fault is caught.
- Flaky tests are fixed or deleted, never retried. The suite has no retries.

## 5. What is deliberately not covered

- **A real payment provider or carrier.** Webhooks are tested with the same signing scheme, not against a live provider.
- **Authentication beyond a bearer token.** Token issuing, expiry and refresh are out of scope for this service.
- **Mobile and web front ends.** This project tests the backend; the UI side is covered by the Playwright, Cypress and Selenium projects in this portfolio.
- **Very long soak runs** and **multi-instance deployments** (several copies of the service behind a load balancer). The Redis-based design is meant for it, but it is not exercised here.
- **Exact capacity of a production machine.** Load numbers come from a small CI runner; they show behaviour and bottlenecks, not what a production server can do.

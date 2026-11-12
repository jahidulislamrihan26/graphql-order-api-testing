# Mutation testing report

A test suite that passes proves little unless it would fail when the service is wrong. This report measures exactly that.

**Method.** The service contains 20 deliberate faults ([src/faults.ts](../src/faults.ts)), each off unless `FAULT=<name>` is set. For every fault the whole suite (116 tests) is run with that one fault switched on. A fault is *killed* if a test fails, and *survives* if every test still passes (a gap in the tests). The suite passes with no fault switched on.

**Result: 20 of 20 faults killed (100%).**

| # | Injected fault | Result | First test to catch it |
|---|---|---|---|
| 1 | An order can be cancelled after it has shipped | Killed | cancellations-and-returns.test.ts: cancellations refuses to cancel an order that is already SHIPPED, and keeps the stock taken |
| 2 | Webhooks are accepted without checking the signature | Killed | webhooks.test.ts: who is calling: signature and timestamp rejects a wrong signature and changes nothing |
| 3 | A captured webhook can be replayed hours later | Killed | webhooks.test.ts: who is calling: signature and timestamp rejects a captured request replayed later (timestamp too old) |
| 4 | The same webhook event can be applied more than once | Killed | webhooks.test.ts: providers retry: the same event must never be applied twice answers "duplicate" and changes nothing the second time |
| 5 | A "payment failed" notice cancels an order that is already paid | Killed | webhooks.test.ts: events that arrive early, late or out of order ignores a "payment failed" notice for an order that is already paid |
| 6 | Cancelling an order does not put the stock back | Killed | webhooks.test.ts: events that arrive early, late or out of order ignores a payment confirmation for an order that was already cancelled, and does not take the stock again |
| 7 | The cached stock figure is not refreshed after a checkout | Killed | webhooks.test.ts: failure scenarios the cached stock figure is corrected after a failed payment (no stale cache) |
| 8 | Checkout does not lock the product row (overselling under load) | Killed | concurrency.test.ts: many customers at once never sells more than the stock: 30 customers fight over 7 items |
| 9 | The order total ignores the quantity ordered | Killed | checkout.test.ts: checkout creates a PENDING_PAYMENT order with the prices as they were at checkout |
| 10 | Returns are accepted at any time after delivery | Killed | cancellations-and-returns.test.ts: returns refuses a return after the 30-day window, and accepts one on day 29 |
| 11 | A customer can cancel or return someone else's order | Killed | cancellations-and-returns.test.ts: cancellations does not let a customer cancel someone else's order (and does not reveal that it exists) |
| 12 | Admin operations work without the admin key | Killed | cancellations-and-returns.test.ts: returns keeps completing a return an admin-only operation |
| 13 | The per-user rate limit is not applied | Killed | redis.test.ts: rate limiting in Redis allows the configured number of mutations per minute, then answers RATE_LIMITED |
| 14 | Deeply nested queries are accepted | Killed | graphql.test.ts: query depth limit rejects a query nested beyond the limit, before it reaches the database |
| 15 | Internal error details are returned to the client | Killed | graphql.test.ts: requests the schema must refuse does not leak internal details when something breaks inside the service |
| 16 | Listing orders issues a query per row instead of batching | Killed | graphql.test.ts: efficiency: a list of orders must not cost a query per row loads 15 orders with their items and products in at most 6 queries |
| 17 | The cart has no lifetime in Redis | Killed | redis.test.ts: the cart lives in Redis stores the cart as a hash keyed by user, with a one-hour lifetime |
| 18 | The last product of a page is repeated on the next page | Killed | graphql.test.ts: pagination walks the whole catalogue page by page: no product twice, none missed, in id order |
| 19 | The customer is not notified when the order ships | Killed | order-lifecycle.test.ts: a normal order, end to end sends the customer a notification for each milestone, in order |
| 20 | A payment confirmation revives a cancelled order | Killed | order-lifecycle.test.ts: state machine rules lists every legal move, and nothing else is allowed (all 64 pairs) |

## Reproduce
```bash
npm run mutation
```
Takes about 10 minutes. Start PostgreSQL yourself (docker compose up -d) or let the suite start an embedded one.

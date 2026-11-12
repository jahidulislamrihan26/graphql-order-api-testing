# Mutation testing report

A test suite that passes proves little unless it would fail when the service is wrong. This report measures exactly that.

**Method.** The service contains 20 deliberate faults ([src/faults.ts](../src/faults.ts)), each off unless `FAULT=<name>` is set. For every fault the whole suite (124 tests) is run with that one fault switched on. A fault is *killed* if a test fails, and *survives* if every test still passes (a gap in the tests). The suite passes with no fault switched on.

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
| 9 | The order total ignores the quantity ordered | Killed | integrity.test.ts: integrity checks finds nothing wrong after a delivered order, a cancelled order and a completed return |
| 10 | Returns are accepted at any time after delivery | Killed | integrity.test.ts: integrity checks finds nothing wrong after a delivered order, a cancelled order and a completed return |
| 11 | A customer can cancel or return someone else's order | Killed | integrity.test.ts: integrity checks finds nothing wrong after a delivered order, a cancelled order and a completed return |
| 12 | Admin operations work without the admin key | Killed | integrity.test.ts: integrity checks finds nothing wrong after a delivered order, a cancelled order and a completed return |
| 13 | The per-user rate limit is not applied | Killed | integrity.test.ts: integrity checks finds nothing wrong after a delivered order, a cancelled order and a completed return |
| 14 | Deeply nested queries are accepted | Killed | integrity.test.ts: integrity checks finds nothing wrong after a delivered order, a cancelled order and a completed return |
| 15 | Internal error details are returned to the client | Killed | integrity.test.ts: integrity checks finds nothing wrong after a delivered order, a cancelled order and a completed return |
| 16 | Listing orders issues a query per row instead of batching | Killed | integrity.test.ts: integrity checks finds nothing wrong after a delivered order, a cancelled order and a completed return |
| 17 | The cart has no lifetime in Redis | Killed | integrity.test.ts: integrity checks finds nothing wrong after a delivered order, a cancelled order and a completed return |
| 18 | The last product of a page is repeated on the next page | Killed | integrity.test.ts: integrity checks finds nothing wrong after a delivered order, a cancelled order and a completed return |
| 19 | The customer is not notified when the order ships | Killed | integrity.test.ts: integrity checks finds nothing wrong after a delivered order, a cancelled order and a completed return |
| 20 | A payment confirmation revives a cancelled order | Killed | integrity.test.ts: integrity checks finds nothing wrong after a delivered order, a cancelled order and a completed return |

## Reproduce
```bash
npm run mutation
```
Takes about 10 minutes. Start PostgreSQL yourself (docker compose up -d) or let the suite start an embedded one.

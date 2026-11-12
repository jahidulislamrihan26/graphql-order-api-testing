// Deliberate faults for mutation testing (npm run mutation). With FAULT unset, which is always the case in normal use, nothing here
// does anything. The mutation runner sets FAULT=<name> to switch on one defect at a time and checks that the test suite notices.
export const FAULTS = [
  ['cancel-after-ship', 'An order can be cancelled after it has shipped'],
  ['skip-signature', 'Webhooks are accepted without checking the signature'],
  ['no-timestamp-check', 'A captured webhook can be replayed hours later'],
  ['no-idempotency', 'The same webhook event can be applied more than once'],
  ['payment-failed-cancels-paid', 'A "payment failed" notice cancels an order that is already paid'],
  ['no-restock-on-cancel', 'Cancelling an order does not put the stock back'],
  ['stale-cache', 'The cached stock figure is not refreshed after a checkout'],
  ['no-row-lock', 'Checkout does not lock the product row (overselling under load)'],
  ['total-ignores-quantity', 'The order total ignores the quantity ordered'],
  ['no-return-window', 'Returns are accepted at any time after delivery'],
  ['any-owner-can-act', "A customer can cancel or return someone else's order"],
  ['admin-not-checked', 'Admin operations work without the admin key'],
  ['no-rate-limit', 'The per-user rate limit is not applied'],
  ['no-depth-limit', 'Deeply nested queries are accepted'],
  ['leak-errors', 'Internal error details are returned to the client'],
  ['n-plus-one', 'Listing orders issues a query per row instead of batching'],
  ['cart-never-expires', 'The cart has no lifetime in Redis'],
  ['pagination-overlap', 'The last product of a page is repeated on the next page'],
  ['no-notification-on-ship', 'The customer is not notified when the order ships'],
  ['payment-after-cancel', 'A payment confirmation revives a cancelled order'],
] as const;

export type FaultName = (typeof FAULTS)[number][0];
export const fault = (name: FaultName): boolean => process.env.FAULT === name;

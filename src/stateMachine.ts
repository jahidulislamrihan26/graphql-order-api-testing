export const STATUSES = ['PENDING_PAYMENT', 'PAID', 'FULFILLING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'RETURN_REQUESTED', 'RETURNED'] as const;
export type Status = (typeof STATUSES)[number];

/** Every legal move of an order. Anything not listed here is rejected. */
export const ALLOWED: Record<Status, readonly Status[]> = {
  PENDING_PAYMENT: ['PAID', 'CANCELLED'],
  PAID: ['FULFILLING', 'CANCELLED'],
  FULFILLING: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['DELIVERED'],
  DELIVERED: ['RETURN_REQUESTED'],
  RETURN_REQUESTED: ['RETURNED'],
  CANCELLED: [],
  RETURNED: [],
};

export const canTransition = (from: Status, to: Status): boolean => ALLOWED[from].includes(to);

/** The customer notification created when an order enters a status. */
export const NOTIFICATION_FOR: Partial<Record<Status, string>> = {
  PAID: 'order_confirmed',
  SHIPPED: 'order_shipped',
  DELIVERED: 'order_delivered',
  CANCELLED: 'order_cancelled',
  RETURNED: 'return_completed',
};

/** Statuses from which cancelling puts the reserved stock back on the shelf. */
export const CANCELLABLE: readonly Status[] = ['PENDING_PAYMENT', 'PAID', 'FULFILLING'];

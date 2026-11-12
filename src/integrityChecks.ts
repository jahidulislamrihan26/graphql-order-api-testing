import type { Db } from './db.js';

/** Starting stock of every catalogue product (see seed() in db.ts). */
export const SEED_STOCK = 1_000_000;

/** Each check is a query that returns the rows which BREAK a rule. No rows means the rule holds. */
export const CHECKS: ReadonlyArray<{ name: string; sql: string }> = [
  { name: 'no product has negative stock', sql: 'select id from products where stock < 0' },
  {
    name: 'stock equals what was seeded minus what open (not cancelled) orders hold, for every catalogue product (nothing oversold, nothing lost)',
    sql: `select p.id, p.stock from products p left join order_items oi on oi.product_id = p.id left join orders o on o.id = oi.order_id
          where p.id <= 200 and p.name like 'Product %' group by p.id, p.stock
          having p.stock <> ${SEED_STOCK} - coalesce(sum(oi.quantity) filter (where o.status <> 'CANCELLED'), 0)`,
  },
  { name: 'every order total equals the sum of its lines', sql: 'select o.id from orders o join order_items i on i.order_id = o.id group by o.id, o.total_cents having o.total_cents <> sum(i.quantity * i.unit_price_cents)' },
  { name: 'every order has at least one line', sql: 'select o.id from orders o left join order_items i on i.order_id = o.id where i.order_id is null' },
  { name: 'every order has exactly one creation event', sql: "select o.id from orders o left join order_events e on e.order_id = o.id and e.type = 'order_created' group by o.id having count(e.id) <> 1" },
  { name: 'every order history is a legal chain: each event starts where the previous one ended', sql: 'select order_id from (select order_id, from_status, lag(to_status) over (partition by order_id order by id) as previous from order_events) x where previous is not null and from_status is distinct from previous group by order_id' },
  { name: 'no order was confirmed twice (each webhook applied once)', sql: "select order_id from order_events where to_status = 'PAID' group by order_id having count(*) > 1" },
  { name: 'every paid order has exactly one confirmation notification', sql: "select o.id from orders o left join notifications n on n.order_id = o.id and n.kind = 'order_confirmed' where o.status = 'PAID' group by o.id having count(n.id) <> 1" },
  { name: "every order's status matches the last event of its history", sql: 'select o.id from orders o join lateral (select to_status from order_events where order_id = o.id order by id desc limit 1) e on true where o.status <> e.to_status' },
];

export interface CheckResult { name: string; violations: number; example?: unknown }

export async function runChecks(db: Db): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  for (const c of CHECKS) {
    const { rows } = await db.query(c.sql);
    out.push({ name: c.name, violations: rows.length, example: rows[0] });
  }
  return out;
}

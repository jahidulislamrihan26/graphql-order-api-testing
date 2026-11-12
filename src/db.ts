import pg from 'pg';

export type Db = pg.Pool;

export function createPool(databaseUrl: string, max = 20): Db {
  return new pg.Pool({ connectionString: databaseUrl, max });
}

const MIGRATION = `
create table if not exists products (
  id serial primary key,
  name text not null,
  price_cents integer not null check (price_cents > 0),
  stock integer not null check (stock >= 0)
);
create table if not exists users (
  id serial primary key,
  email text unique not null,
  token text unique not null
);
create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  user_id integer not null references users(id),
  status text not null,
  total_cents integer not null check (total_cents >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  delivered_at timestamptz
);
create index if not exists idx_orders_user on orders(user_id, created_at desc);
create table if not exists order_items (
  order_id uuid not null references orders(id),
  product_id integer not null references products(id),
  quantity integer not null check (quantity > 0),
  unit_price_cents integer not null,
  primary key (order_id, product_id)
);
create table if not exists order_events (
  id bigserial primary key,
  order_id uuid not null references orders(id),
  type text not null,
  from_status text,
  to_status text,
  source text not null,
  created_at timestamptz not null default now()
);
create table if not exists notifications (
  id bigserial primary key,
  user_id integer not null references users(id),
  order_id uuid not null references orders(id),
  kind text not null,
  created_at timestamptz not null default now()
);
create table if not exists returns (
  id bigserial primary key,
  order_id uuid unique not null references orders(id),
  reason text not null,
  status text not null,
  created_at timestamptz not null default now()
);
create table if not exists webhook_events (
  event_id text primary key,
  type text not null,
  order_id uuid,
  outcome text not null,
  received_at timestamptz not null default now()
);
`;

export async function migrate(db: Db): Promise<void> {
  await db.query(MIGRATION);
}

export const USERS = [
  { email: 'alice@shop.test', token: 'token-alice' },
  { email: 'bob@shop.test', token: 'token-bob' },
  { email: 'carol@shop.test', token: 'token-carol' },
];

/** Reference data: a catalogue of 200 products and three test users. Safe to run more than once. */
export async function seed(db: Db): Promise<void> {
  for (const u of USERS) await db.query('insert into users (email, token) values ($1, $2) on conflict do nothing', [u.email, u.token]);
  const { rows } = await db.query('select count(*)::int as n from products');
  if (rows[0].n >= 200) return;
  await db.query(
    `insert into products (name, price_cents, stock)
     select 'Product ' || g, 500 + (g * 37) % 9500, 1000000 from generate_series(1, 200) g`,
  );
}

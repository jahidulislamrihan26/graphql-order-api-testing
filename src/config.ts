// Everything the service reads from its environment, in one place, so tests can start several differently configured instances.
export interface Config {
  port: number;
  databaseUrl: string;
  dbPoolMax: number;            // connections the service may hold open to PostgreSQL
  redisUrl?: string;            // unset: an in-memory Redis stand-in is used (quick local runs); CI and load tests use a real Redis
  webhookSecret: string;
  adminKey: string;
  rateLimitPerMinute: number;   // mutations per user per minute
  maxQueryDepth: number;
  returnWindowDays: number;
  webhookToleranceSeconds: number;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const env = process.env;
  return {
    port: Number(env.PORT ?? 4000),
    databaseUrl: env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/shop',
    dbPoolMax: Number(env.PG_POOL_MAX ?? 20),
    redisUrl: env.REDIS_URL,
    webhookSecret: env.WEBHOOK_SECRET ?? 'whsec_test_secret',
    adminKey: env.ADMIN_KEY ?? 'admin-secret',
    rateLimitPerMinute: Number(env.RATE_LIMIT_PER_MINUTE ?? 600),
    maxQueryDepth: Number(env.MAX_QUERY_DEPTH ?? 8),
    returnWindowDays: Number(env.RETURN_WINDOW_DAYS ?? 30),
    webhookToleranceSeconds: Number(env.WEBHOOK_TOLERANCE_SECONDS ?? 300),
    ...overrides,
  };
}

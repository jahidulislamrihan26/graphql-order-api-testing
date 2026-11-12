import { Redis } from 'ioredis';

export type RedisClient = Redis;

/** A real Redis when REDIS_URL is set; otherwise an in-memory stand-in (ioredis-mock) so the suite also runs on a laptop with no Redis. */
export async function createRedis(url?: string): Promise<RedisClient> {
  if (url) return new Redis(url, { maxRetriesPerRequest: 2 });
  const { default: RedisMock } = await import('ioredis-mock');
  return new RedisMock() as unknown as RedisClient;
}

import { createClient } from 'redis';
import { createLogger } from './logger.js';

export type RedisClient = ReturnType<typeof createClient>;

const REDIS_CONNECT_TIMEOUT_MS = 5000;

// One shared client for both the RedisCache and RedisRateLimiter adapters, bound
// by createApp when REDIS_URL is set. node-redis throws at the process level if no
// 'error' listener is attached, so we attach one and log instead of crashing;
// connect() is fire-and-forget - commands issued before the socket is ready are
// queued by node-redis, and each adapter fast-paths on `isReady` so a request
// never hangs on a reconnecting socket.
export function createRedisClient(url: string): RedisClient {
  const logger = createLogger('redis');
  const client = createClient({
    url,
    socket: {
      connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
      reconnectStrategy: (retries) => Math.min(retries * 100, 2000),
    },
  });
  client.on('error', (err: unknown) => logger.error({ err }, 'redis client error'));
  client.connect().catch((err: unknown) => logger.error({ err }, 'redis connect failed'));
  return client;
}

import { createClient } from 'redis';
import { createLogger } from './logger.js';

export type RedisClient = ReturnType<typeof createClient>;

const REDIS_CONNECT_TIMEOUT_MS = 5000;

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

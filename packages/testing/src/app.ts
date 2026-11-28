import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import {
  createApp,
  createRedisClient,
  BullMqJobQueue,
  RedisCache,
  RedisRateLimiter,
  RedisStreamsBroker,
  RedisPubSubRealtimeTransport,
  type CreateAppConfig,
  type Container,
  type CoreTokenCatalog,
} from '@openora/core/server';
import {
  MESSAGE_BROKER,
  JOB_QUEUE,
  CACHE,
  RATE_LIMITER,
  REALTIME_TRANSPORT,
  REALTIME_CLIENT_AUTHORIZER,
} from '@openora/core/contracts';
import { user, session, account, verification, twoFactor } from '@openora/core/pam/schema/identity';
import { SseClientAuthorizer } from '@openora/core/testing';
import { acquireTestRedisDatabase } from './redis.js';
import { traceFetch } from './trace-recorder.js';
import type { Hono } from 'hono';

const REDIS_READY_TIMEOUT_MS = 10_000;

export type TestApp = {
  app: Hono;
  container: Container<CoreTokenCatalog>;
  redisUrl: string;
  close(): Promise<void>;
};

export type BootTestAppConfig = Pick<CreateAppConfig, 'plugins' | 'igaming'> & {
  databaseUrl: string;
};

export async function bootTestApp(config: BootTestAppConfig): Promise<TestApp> {
  const redisDatabase = await acquireTestRedisDatabase();
  const serviceName = `test-${randomUUID()}`;
  let client: ReturnType<typeof createRedisClient> | undefined;

  let created;
  try {
    created = await createApp(
      {
        plugins: [
          {
            id: 'testing-registration-config',
            path: fileURLToPath(new URL('./test-registration-config-plugin.ts', import.meta.url)),
          },
          {
            id: 'testing-email-capture',
            path: fileURLToPath(new URL('./test-email-capture-plugin.ts', import.meta.url)),
          },
          ...config.plugins,
        ],
        ...(config.igaming ? { igaming: config.igaming } : {}),
        databaseUrl: config.databaseUrl,
        cors: false,
        authSchema: { user, session, account, verification, twoFactor },
      },
      (container: Container<CoreTokenCatalog>) => {
        const redis = createRedisClient(redisDatabase.url);
        client = redis;
        container.onDispose(() => redis.close());

        container.register(MESSAGE_BROKER, () => {
          const broker = new RedisStreamsBroker(redis, { serviceName, startId: '0' });
          container.onDispose(() => broker.close());
          return broker;
        });
        container.register(JOB_QUEUE, () => {
          const queue = new BullMqJobQueue(redisDatabase.url);
          container.onDispose(() => queue.close());
          return queue;
        });
        container.register(CACHE, () => new RedisCache(redis));
        container.register(RATE_LIMITER, () => new RedisRateLimiter(redis));

        if (!container.has(REALTIME_TRANSPORT)) {
          container.register(REALTIME_TRANSPORT, () => {
            const transport = new RedisPubSubRealtimeTransport(redis, serviceName);
            container.onDispose(() => transport.close());
            return transport;
          });
        }
        if (!container.has(REALTIME_CLIENT_AUTHORIZER)) {
          container.register(REALTIME_CLIENT_AUTHORIZER, () => new SseClientAuthorizer());
        }
      },
    );

    if (client && !client.isReady) {
      await once(client, 'ready', { signal: AbortSignal.timeout(REDIS_READY_TIMEOUT_MS) });
    }
  } catch (err) {
    await Promise.allSettled([created?.close(), redisDatabase.release()]);
    throw err;
  }

  traceFetch(created.app);
  return {
    app: created.app,
    container: created.container,
    redisUrl: redisDatabase.url,
    async close(): Promise<void> {
      await created.close();
      await redisDatabase.release();
    },
  };
}

import { randomUUID } from 'node:crypto';
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
import type { Hono } from 'hono';

export type TestApp = {
  /** The Hono app - drive it directly with `app.request(path, init)`. */
  app: Hono;
  /** The composition container, for resolving services/tokens in assertions. */
  container: Container<CoreTokenCatalog>;
  /** Dispose the container (closes the DB pool, drains workers, frees the Redis db). */
  close(): Promise<void>;
};

export type BootTestAppConfig = Pick<CreateAppConfig, 'plugins' | 'igaming'> & {
  databaseUrl: string;
};

/**
 * Boot the full Hono + oRPC app in-process against a test database. No network
 * listener is opened - exercise routes with `app.request()` (the canonical Hono
 * test approach). CORS is left at the default.
 *
 * Pass the same plugins the real entrypoint uses (in OSS that is `loadExtensions()`;
 * a consumer passes its own).
 *
 * The five durable seams run on the SAME drivers production uses - Redis Streams,
 * BullMQ, Redis cache, Redis rate limiter and Redis Pub/Sub - so event fan-out, job
 * retries, throttling and realtime push are exercised for real rather than through
 * an in-process stand-in. Each booted app claims its own Redis logical database, so
 * several apps in one test file cannot compete for each other's events, jobs, cache
 * entries or channels.
 *
 * The broker reads from `startId: '0'` here, unlike production's `$`: a test acts
 * within milliseconds of boot, and a group created lazily at `$` would silently drop
 * anything published before it existed. Replay is harmless against a flushed database.
 *
 * `REALTIME_TRANSPORT` binds the same `RedisPubSubRealtimeTransport` production uses
 * (ADR-0031) - core ships no in-process fallback, so there is nothing else to bind.
 */
// Mirrors what the consumer composition root does. See ADR-0025.
export async function bootTestApp(config: BootTestAppConfig): Promise<TestApp> {
  const redisDatabase = await acquireTestRedisDatabase();
  const serviceName = `test-${randomUUID()}`;

  const created = await createApp(
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
      authSchema: { user, session, account, verification, twoFactor },
    },
    (container: Container<CoreTokenCatalog>) => {
      const redis = createRedisClient(redisDatabase.url);
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

  return {
    app: created.app,
    container: created.container,
    async close(): Promise<void> {
      await created.close();
      await redisDatabase.release();
    },
  };
}

import {
  createApp,
  createLogger,
  type CreateAppConfig,
  type Container,
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
import {
  InMemoryBroker,
  InProcessJobQueue,
  InProcessCache,
  InProcessRateLimiter,
  InProcessRealtimeTransport,
  SseClientAuthorizer,
} from '@openora/core/testing';
import type { Hono } from 'hono';

export type TestApp = {
  /** The Hono app - drive it directly with `app.request(path, init)`. */
  app: Hono;
  /** The composition container, for resolving services/tokens in assertions. */
  container: Container;
  /** Dispose the container (closes the DB pool, drains workers). */
  close(): Promise<void>;
};

export type BootTestAppConfig = Pick<CreateAppConfig, 'plugins' | 'contract' | 'igaming'> & {
  databaseUrl: string;
};

/**
 * Boot the full Hono + oRPC app in-process against a test database. No network
 * listener is opened - exercise routes with `app.request()` (the canonical Hono
 * test approach). OpenAPI emission is disabled; CORS is left at the default.
 *
 * Pass the same `plugins` + `contract` the real entrypoint uses (in OSS that is
 * `loadExtensions()` + `@openora/core/contracts`; a consumer passes its own).
 *
 * Production is distributed-only (ADR-0030) - `createApp` no longer ships in-process
 * defaults for `MESSAGE_BROKER`/`JOB_QUEUE`/`CACHE`/`RATE_LIMITER` and throws if they're
 * unbound. This `configure` callback binds the `@openora/core/testing` fakes as a
 * FALLBACK (only when a plugin hasn't already bound the token) before `createApp`'s
 * durable-seam assertion runs, so the suite still boots with zero infra by default,
 * while a test that wants to exercise a real broker/queue overlay via `config.plugins`
 * keeps that overlay's binding instead of being silently overridden.
 */
// Mirrors what the consumer composition root does. See ADR-0025.
export async function bootTestApp(config: BootTestAppConfig): Promise<TestApp> {
  const created = await createApp({
    plugins: config.plugins,
    ...(config.contract ? { contract: config.contract } : {}),
    ...(config.igaming ? { igaming: config.igaming } : {}),
    databaseUrl: config.databaseUrl,
    authSchema: { user, session, account, verification, twoFactor },
    openapi: { enabled: false },
    configure(container: Container) {
      if (!container.has(MESSAGE_BROKER)) {
        container.register(MESSAGE_BROKER, () => {
          const broker = new InMemoryBroker();
          container.onDispose(() => broker.close());
          return broker;
        });
      }
      if (!container.has(JOB_QUEUE)) {
        container.register(JOB_QUEUE, () => {
          const q = new InProcessJobQueue(createLogger('job-queue'));
          container.onDispose(() => q.close());
          return q;
        });
      }
      if (!container.has(CACHE)) {
        container.register(CACHE, () => {
          const cache = new InProcessCache();
          container.onDispose(() => cache.close());
          return cache;
        });
      }
      if (!container.has(RATE_LIMITER)) {
        container.register(RATE_LIMITER, () => {
          const limiter = new InProcessRateLimiter();
          container.onDispose(() => limiter.close());
          return limiter;
        });
      }
      // REALTIME stays lazy in production (throws on first use), but the suite may
      // exercise realtime routes - bind the fakes so those tests run with zero infra.
      if (!container.has(REALTIME_TRANSPORT)) {
        container.register(REALTIME_TRANSPORT, () => new InProcessRealtimeTransport());
      }
      if (!container.has(REALTIME_CLIENT_AUTHORIZER)) {
        container.register(REALTIME_CLIENT_AUTHORIZER, () => new SseClientAuthorizer());
      }
    },
  });

  return {
    app: created.app,
    container: created.container,
    close: created.close,
  };
}

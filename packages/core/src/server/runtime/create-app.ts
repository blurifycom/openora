import { OpenAPIHandler } from '@orpc/openapi/fetch';
import { implement, onError, ORPCError, type AnyRouter } from '@orpc/server';
import { ResponseHeadersPlugin } from '@orpc/server/plugins';
import type { ContractRouter } from '@orpc/contract';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { etag } from 'hono/etag';
import { HTTPException } from 'hono/http-exception';
import { serve, type ServerType } from '@hono/node-server';
import { resolve } from 'node:path';
import { generateOpenApiSpec } from './openapi.js';
import {
  Container,
  BullMqJobQueue,
  RedisCache,
  RedisRateLimiter,
  RedisStreamsBroker,
  createEventBus,
  createLogger,
  createRedisClient,
  withRequestContext,
  setErrorReporter,
  EVENT_BUS,
  extractClientMeta,
  type OssContext,
} from '../kernel/index.js';
import { randomUUID } from 'node:crypto';
import {
  MESSAGE_BROKER,
  JOB_QUEUE,
  OUTBOX,
  ADMIN_PERMISSION_RESOLVER,
  RATE_LIMITER,
  CACHE,
  ERROR_TRACKING,
  composeContract,
  healthContract,
  IGAMING_CONFIG,
  type IgamingConfig,
  PLATFORM_CONFIG,
} from '@openora/core/contracts';
import { DrizzleService, DRIZZLE, DrizzleOutboxWriter, OutboxRelay } from '../db/index.js';
import { AdminGuard, ADMIN_GUARD, SessionResolver, AUTH_SESSION } from '../auth/index.js';
import { loadPlugins, type PluginEntry } from '../plugin-host/index.js';
import { assertDurableSeamsBound } from './assert-durable-seams.js';
import { loadPlatformConfig, resolvePlatformConfigPath } from '../kernel/platform-config-loader.js';
import type { CoreTokenCatalog } from './core-token-catalog.js';

// Path prefixes safe to cache at the HTTP layer: public, non-personalized reads
// only (lobby feeds, public CMS content, the game catalogue). NOTHING
// authenticated or per-player (wallet, profile, notifications, admin, chat) - a
// consumer overrides this via `httpCache.paths` or disables it with `httpCache: false`.
// This list living in the domain-agnostic engine (rather than each module
// declaring its own cacheable routes) is accepted debt.
// '/cms/banners' is excluded on purpose: its `listBanners` route is unguarded and returns
// inactive banners, so HTTP-caching it would leak draft banners to a shared cache.
const PUBLIC_HTTP_CACHE_PATHS: readonly string[] = [
  '/lobby/categories',
  '/lobby/featured',
  '/lobby/search',
  '/cms/pages',
  '/gaming/games',
];

const DEFAULT_HTTP_CACHE_MAX_AGE_SECONDS = 30;
const DEFAULT_HTTP_CACHE_STALE_WHILE_REVALIDATE_SECONDS = 60;

// Redis Streams consumer group name for MESSAGE_BROKER. Distinct deployments/services
// sharing one Redis MUST use distinct names so their subscribers don't compete for
// each other's events. The name is a durable identity: renaming it strands the old
// group's pending (delivered-but-unacked) entries and starts the new one at `$`, so
// it can never be derived from SERVICE_MANIFEST - that is a LIST of module ids
// (see service-manifest.ts) whose value reorders and grows as modules move.
// A split deployment must therefore name itself explicitly.
function resolveServiceName(): string {
  const serviceName = process.env['SERVICE_NAME'];
  if (serviceName) {
    return serviceName;
  }
  if (process.env['SERVICE_MANIFEST']) {
    throw new Error(
      '[create-app] SERVICE_MANIFEST is set but SERVICE_NAME is not. A split service needs a stable ' +
        'name of its own: it becomes the MESSAGE_BROKER consumer group, and every service sharing a ' +
        'group competes for the same events instead of each receiving a copy. Set SERVICE_NAME to a ' +
        'stable identifier for this deployment (eg SERVICE_NAME=wallet).',
    );
  }
  return 'monolith';
}

export type CreateAppConfig = {
  plugins: PluginEntry[];

  // The better-auth identity tables (user/session/account/verification/twoFactor),
  // owned by the consumer's PAM/identity module. The engine is domain-agnostic and
  // never imports a domain schema - the composition root injects these so the
  // SessionResolver can verify the session cookie. Omit for a no-auth edition
  // (session verification is then disabled). See ADR-0019/0025.
  authSchema?: Record<string, unknown>;

  port?: number;

  cors?: boolean | { origins?: string | string[] };

  databaseUrl?: string;

  // The shape is genuinely unknown at this factory boundary (an external oRPC generic) -
  // the documented `any` exception for an external library's untyped surface.
  // oxlint-disable-next-line typescript/no-explicit-any
  contract?: ContractRouter<any>;

  openapi?: {
    enabled?: boolean;
    info?: { title?: string; version?: string };
    outputPath?: string;
  };

  igaming?: IgamingConfig;

  // GET-only, path-prefix-matched Cache-Control on PUBLIC_HTTP_CACHE_PATHS (or a
  // supplied override). `false` disables HTTP response caching entirely.
  httpCache?: { paths?: string[]; maxAgeSeconds?: number } | false;

  configure?: (container: Container<CoreTokenCatalog>) => void | Promise<void>;

  disableHealthModule?: boolean;
};

export type CreatedApp = {
  app: Hono;
  container: Container<CoreTokenCatalog>;
  port: number;
  listen(): Promise<void>;
  emitOpenApiSpec(): Promise<string | null>;
  close(): Promise<void>;
};

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

// Webhook signature schemes (eg aggregator callbacks) must hash the verbatim body,
// so the runtime captures it before oRPC parses the request. Bounded to keep an
// oversized payload from buffering into memory - past the cap rawBody stays unset
// and the signature check fails closed (401).
const MAX_CAPTURED_BODY_BYTES = 1_048_576;

async function captureRawBody(req: Request): Promise<string | undefined> {
  if (!req.body) {
    return undefined;
  }
  const declaredLength = req.headers.get('content-length');
  if (declaredLength && Number(declaredLength) > MAX_CAPTURED_BODY_BYTES) {
    return undefined;
  }
  // content-length can be absent (chunked) or lie, so bound the actual stream rather
  // than trusting the header: stop and bail past the cap so memory stays bounded and
  // the signature check fails closed.
  const clonedBody = req.clone().body;
  if (!clonedBody) {
    return undefined;
  }
  const reader = clonedBody.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > MAX_CAPTURED_BODY_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The single composition root: wires the DI container, boots every plugin in
 * `config.plugins`, and mounts the resulting oRPC router on a Hono app.
 * Production is distributed-only (ADR-0030, superseding ADR-0010/0014/0016/0028):
 * `REDIS_URL` auto-binds `JOB_QUEUE`/`RATE_LIMITER`/`CACHE`/`MESSAGE_BROKER` to their
 * Redis-backed drivers - the broker being the `RedisStreamsBroker` reference driver,
 * which an overlay (RabbitMQ/Kafka) or a test's `configure` callback can replace.
 * `assertDurableSeamsBound` runs right after
 * plugins + `configure` and throws a clear, actionable error listing every
 * always-needed seam that still has no binding - it never falls back to an
 * in-process realtime implementation. `OUTBOX_ENABLED` (or
 * `AMQP_URL`/`RABBITMQ_URL`) enables the transactional outbox relay.
 * `container.dispose()` (via `close()`) runs disposers in REVERSE registration
 * order, so DRIZZLE is registered before JOB_QUEUE to guarantee workers drain
 * before the DB closes. A router namespace registered by more than one plugin
 * throws at boot, not at request time.
 */
export async function createApp(config: CreateAppConfig): Promise<CreatedApp> {
  if (config.databaseUrl) {
    process.env['DATABASE_URL'] = config.databaseUrl;
  }

  const container = new Container<CoreTokenCatalog>();
  container.register(DRIZZLE, () => {
    const svc = new DrizzleService();
    container.onDispose(() => svc.dispose());
    return svc;
  });
  // A distributed deployment wants events that survive a crash between commit and
  // publish. Off by default: emit() keeps its best-effort fan-out and
  // emitInTransaction() throws a guiding error until this is enabled.
  // AMQP_URL/RABBITMQ_URL only signal the INTENT to run a RabbitMQ broker overlay -
  // core binds no AMQP driver, so they enable the outbox and nothing else. The relay
  // publishes to whatever MESSAGE_BROKER resolves to (the Redis Streams driver below,
  // unless an overlay replaced it); set OUTBOX_ENABLED directly when that is the aim.
  const outboxEnabled =
    !!process.env['OUTBOX_ENABLED'] || !!process.env['AMQP_URL'] || !!process.env['RABBITMQ_URL'];
  if (outboxEnabled) {
    container.register(OUTBOX, () => new DrizzleOutboxWriter());
  }
  container.register(EVENT_BUS, (c) =>
    createEventBus(
      c.get(MESSAGE_BROKER),
      createLogger('event-bus'),
      outboxEnabled ? c.get(OUTBOX) : undefined,
    ),
  );
  // When REDIS_URL is set, JOB_QUEUE, the rate limiter, the cache and the message
  // broker bind to the shipped Redis reference adapters: BullMQ-backed durable jobs
  // (survive restarts, real cron), distributed throttling, cross-replica cache
  // invalidation and cross-replica events over Redis Streams. There is no in-process
  // fallback (ADR-0030) - a deployment without REDIS_URL must bind these itself (an
  // overlay, or a test's `configure` callback), or `assertDurableSeamsBound` below
  // throws. The JOB_QUEUE disposer drains in-flight jobs before the DB closes (DRIZZLE
  // is resolved before JOB_QUEUE below, and disposers run in reverse).
  const redisUrl = process.env['REDIS_URL'];
  if (redisUrl) {
    // Resolved eagerly, before any client is opened: a misconfigured service name is
    // a boot error, not a surprise on whichever code path resolves the broker first.
    const serviceName = resolveServiceName();
    container.register(JOB_QUEUE, () => {
      const q = new BullMqJobQueue(redisUrl);
      container.onDispose(() => q.close());
      return q;
    });
    const redis = createRedisClient(redisUrl);
    container.onDispose(() => redis.close());
    container.register(RATE_LIMITER, () => new RedisRateLimiter(redis));
    container.register(CACHE, () => new RedisCache(redis));
    container.register(MESSAGE_BROKER, () => {
      const broker = new RedisStreamsBroker(redis, { serviceName });
      container.onDispose(() => broker.close());
      return broker;
    });
  }
  // One shared better-auth instance for both the per-request middleware and AdminGuard -
  // no second createAuth() over the same DB. authSchema is injected (not imported) because
  // the engine is domain-agnostic (ADR-0019/0025).
  container.register(AUTH_SESSION, (c) => new SessionResolver(c.get(DRIZZLE), config.authSchema));
  container.register(
    ADMIN_GUARD,
    (c) =>
      new AdminGuard(
        c.get(DRIZZLE),
        c.get(AUTH_SESSION),
        // has() avoids throwing on an unbound token so boot works without the iam module.
        c.has(ADMIN_PERMISSION_RESOLVER) ? c.get(ADMIN_PERMISSION_RESOLVER) : undefined,
        c.get(EVENT_BUS),
      ),
  );
  if (config.igaming) {
    const igaming = config.igaming;
    container.register(IGAMING_CONFIG, () => igaming);
  }
  // Always bound: loadPlatformConfig() falls back to an empty-but-valid config
  // when no platform-config.{yaml,yml,json} file is present (PLATFORM_CONFIG_PATH
  // or cwd discovery). See platform-config-loader.ts.
  container.register(PLATFORM_CONFIG, () => loadPlatformConfig(resolvePlatformConfigPath()));

  const registry = await loadPlugins(config.plugins, container);
  await config.configure?.(container);

  assertDurableSeamsBound(container);

  if (container.has(ERROR_TRACKING)) {
    const tracker = container.get(ERROR_TRACKING);
    setErrorReporter((error, context) => tracker.captureException(error, context));
    container.onDispose(() => setErrorReporter(undefined));
  }

  const bus = container.get(EVENT_BUS);
  for (const [event, handlers] of registry.events.getAll()) {
    for (const handler of handlers) {
      bus.on(event, handler);
    }
  }

  // Resolve DRIZZLE before JOB_QUEUE so disposers run in the right order (workers
  // drain before the DB closes, since disposers run in reverse).
  const drizzle = container.get(DRIZZLE);
  const jobQueue = container.get(JOB_QUEUE);
  for (const registration of registry.jobs.getAll()) {
    jobQueue.registerWorker(registration);
  }

  if (outboxEnabled) {
    const relay = new OutboxRelay(drizzle.db, container.get(MESSAGE_BROKER), {
      onError: (err) => createLogger('outbox-relay').error({ err }, 'outbox drain failed'),
    });
    relay.start();
    container.onDispose(() => relay.stop());
  }

  const router: Record<string, AnyRouter> = {};
  for (const [namespace, factory] of registry.routers.getAll()) {
    if (namespace in router) {
      throw new Error(`Router namespace "${namespace}" is registered by more than one plugin`);
    }
    router[namespace] = factory(container) as AnyRouter;
  }

  if (!config.disableHealthModule) {
    const os = implement(healthContract).$context<OssContext>();
    router['health'] = os.router({
      ping: os.ping.handler(() => ({ status: 'ok' as const, timestamp: new Date().toISOString() })),
    }) as AnyRouter;
  }

  const handler = new OpenAPIHandler(router, {
    plugins: [new ResponseHeadersPlugin()],
    interceptors: [
      onError((error) => {
        // oRPC wraps a thrown native error (a DB failure, a bug) into an
        // ORPCError('INTERNAL_SERVER_ERROR', { cause }). Report anything that is a
        // server fault - a non-ORPCError, or an ORPCError with a 5xx status - and skip
        // expected client errors (4xx: not-found, conflict, validation, rate-limit).
        // Report the underlying `cause` so the tracker gets the real error + stack,
        // not the generic wrapper.
        if (error instanceof ORPCError && error.status < 500) {
          return;
        }
        const err = error instanceof ORPCError ? (error.cause ?? error) : error;
        createLogger('orpc').error({ err }, 'unhandled error');
      }),
    ],
  });

  const app = new Hono();

  // Outermost catch for errors thrown in the Hono middleware chain (session
  // resolution, raw-body capture, etag/cache) - the one seam oRPC's onError
  // interceptor never sees, since handler.handle turns route/service errors into
  // responses. logger.error reports via the reporter; HTTPExceptions are deliberate
  // outcomes, returned without reporting.
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return err.getResponse();
    }
    createLogger('http').error(
      { err, method: c.req.method, path: c.req.path },
      'unhandled request error',
    );
    return c.json({ error: 'Internal Server Error' }, 500);
  });

  if (config.cors !== false) {
    const origins =
      config.cors === true || config.cors === undefined ? undefined : config.cors.origins;
    app.use('/*', cors({ origin: origins ?? ((origin) => origin), credentials: true }));
  }

  if (config.httpCache !== false) {
    const cachePaths = config.httpCache?.paths ?? PUBLIC_HTTP_CACHE_PATHS;
    const maxAgeSeconds = config.httpCache?.maxAgeSeconds ?? DEFAULT_HTTP_CACHE_MAX_AGE_SECONDS;
    const staleWhileRevalidateSeconds = config.httpCache?.maxAgeSeconds
      ? maxAgeSeconds * 2
      : DEFAULT_HTTP_CACHE_STALE_WHILE_REVALIDATE_SECONDS;
    // GET/HEAD only - the etag middleware short-circuits with a 304 on a matching
    // If-None-Match, which would swallow a PUT/DELETE's response after it already
    // ran the mutation (eg PUT /cms/pages/{id} under the /cms/pages cache prefix).
    const etagMiddleware = etag();
    app.use('/*', async (c, next) => {
      const isCacheablePath = cachePaths.some(
        (path) => c.req.path === path || c.req.path.startsWith(`${path}/`),
      );
      const isCacheableMethod = c.req.method === 'GET' || c.req.method === 'HEAD';
      const isCacheable = isCacheableMethod && isCacheablePath;
      if (isCacheable) {
        await etagMiddleware(c, next);
      } else {
        await next();
      }
      c.res.headers.set(
        'Cache-Control',
        isCacheable
          ? `public, max-age=${maxAgeSeconds}, stale-while-revalidate=${staleWhileRevalidateSeconds}`
          : 'no-store',
      );
    });
  }

  const sessions = container.get(AUTH_SESSION);

  app.use('/*', async (c, next) => {
    const headers = headersToRecord(c.req.raw.headers);
    if (!headers['x-real-ip'] && !headers['x-forwarded-for']) {
      const remoteAddress = (c.env as { incoming?: { socket?: { remoteAddress?: string } } })
        ?.incoming?.socket?.remoteAddress;
      if (remoteAddress) {
        headers['x-real-ip'] = remoteAddress;
      }
    }
    const context: OssContext = {
      request: { headers },
      clientMeta: extractClientMeta(headers),
      rawBody: await captureRawBody(c.req.raw),
    };

    // Never identify from a client-supplied `x-user-id` header (W1, ADR-0019).
    const userId = await sessions.resolveUserId(c.req.raw.headers);

    const runHandler = async (): Promise<Response> => {
      const { matched, response } = await handler.handle(c.req.raw, { context });
      if (matched) {
        return c.newResponse(response.body, response);
      }
      await next();
      return c.res;
    };

    const traceId = headers['x-trace-id'] ?? randomUUID();

    if (!userId) {
      // No valid session - context.auth stays undefined so getUserId 401s. Auth and
      // public routes still work. Run inside the request context for trace correlation.
      return withRequestContext({ traceId, clientMeta: context.clientMeta }, runHandler);
    }

    context.auth = { userId };

    return withRequestContext({ userId, traceId, clientMeta: context.clientMeta }, runHandler);
  });

  const port = config.port ?? Number(process.env['PORT_API'] ?? 3001);
  let server: ServerType | undefined;

  return {
    app,
    container,
    port,
    async listen() {
      server = serve({ fetch: app.fetch, port });
      process.stdout.write(`API listening on :${port}\n`);
    },
    async emitOpenApiSpec() {
      if (config.openapi?.enabled === false) {
        return null;
      }
      const outPath = await generateOpenApiSpec(config.contract ?? composeContract({}), {
        info: config.openapi?.info,
        outputPath: config.openapi?.outputPath ?? resolve(process.cwd(), 'docs/openapi.json'),
      });
      process.stdout.write(`OpenAPI spec written to ${outPath}\n`);
      return outPath;
    },
    async close() {
      server?.close();
      await container.dispose();
    },
  };
}

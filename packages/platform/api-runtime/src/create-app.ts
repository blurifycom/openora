import { OpenAPIHandler } from '@orpc/openapi/fetch';
import { implement, onError, ORPCError, type AnyRouter } from '@orpc/server';
import { ResponseHeadersPlugin } from '@orpc/server/plugins';
import type { ContractRouter } from '@orpc/contract';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve, type ServerType } from '@hono/node-server';
import { resolve } from 'node:path';
import { generateOpenApiSpec } from './openapi.js';
import {
  Container,
  InMemoryBroker,
  InProcessJobQueue,
  InProcessRealtimeTransport,
  SseClientAuthorizer,
  createEventBus,
  createLogger,
  withTenant,
  EVENT_BUS,
  type OssContext,
} from '@oss/core';
import { resolveTenantForUser } from './tenant-resolver.js';
import { randomUUID } from 'node:crypto';
import {
  MESSAGE_BROKER,
  JOB_QUEUE,
  REALTIME_TRANSPORT,
  REALTIME_CLIENT_AUTHORIZER,
  OUTBOX,
  ADMIN_PERMISSION_RESOLVER,
} from '@oss/adapters';
import { DrizzleService, DRIZZLE, DrizzleOutboxWriter, OutboxRelay } from '@oss/db';
import { AdminGuard, ADMIN_GUARD, SessionResolver, AUTH_SESSION } from '@oss/auth';
import { user, session, account, verification, twoFactor } from '@oss-addons/identity/schema';
import { loadPlugins, type PluginEntry } from '@oss/plugin-host';
import { contract as defaultContract, healthContract } from '@oss/orpc-contract';
import { IGAMING_CONFIG, type IgamingConfig } from '@oss/shared-schemas';

export type CreateAppConfig = {
  // Plugins to load. Each module/extension exposes a definePlugin() entry.
  plugins: PluginEntry[];

  // Port to listen on. Defaults to env PORT_API, then 3001.
  port?: number;

  // CORS configuration. `true` reflects the request origin with credentials,
  // `false` disables, or pass explicit origins. Defaults to `true`.
  cors?: boolean | { origins?: string | string[] };

  // Override DATABASE_URL at runtime (otherwise read from env).
  databaseUrl?: string;

  // Override the oRPC root contract used for OpenAPI emit.
  // Consumers can compose the OSS contract with their own extensions. The shape is
  // genuinely unknown at this factory boundary (an external oRPC generic) - the
  // documented `any` exception for an external library's untyped surface.
  // oxlint-disable-next-line typescript/no-explicit-any
  contract?: ContractRouter<any>;

  // OpenAPI spec emission settings.
  openapi?: {
    enabled?: boolean; // default true
    info?: { title?: string; version?: string };
    outputPath?: string; // absolute path, default docs/openapi.json next to cwd
  };

  // Declarative igaming configuration (currencies, jurisdictions, limits, provider
  // selection, branding). Build it with defineIgamingConfig() from @oss/shared-schemas.
  // Resolvable app-wide via the IGAMING_CONFIG token.
  igaming?: IgamingConfig;

  // Advanced: rebind/seed the composition container after plugins have registered
  // (eg an operator that wants to override an infra provider directly).
  configure?: (container: Container) => void | Promise<void>;

  // Skip the built-in health route (rarely needed - default false).
  disableHealthModule?: boolean;
};

export type CreatedApp = {
  app: Hono;
  container: Container;
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

export async function createApp(config: CreateAppConfig): Promise<CreatedApp> {
  if (config.databaseUrl) {
    process.env['DATABASE_URL'] = config.databaseUrl;
  }

  // Compose the container: explicit factories, no decorators. Infra is seeded
  // first; plugins then register their services + adapters (last binding wins).
  const container = new Container();
  container.register(DRIZZLE, () => {
    const svc = new DrizzleService();
    container.onDispose(() => svc.dispose());
    return svc;
  });
  // Inter-module transport: default to the in-process broker; an overlay rebinds
  // MESSAGE_BROKER to a durable driver (Redpanda/NATS) without touching modules.
  // The EventBus is the typed facade services depend on.
  container.register(MESSAGE_BROKER, () => {
    const broker = new InMemoryBroker();
    container.onDispose(() => broker.close());
    return broker;
  });
  // Transactional outbox: durable, transaction-atomic event publication. Enabled
  // when OUTBOX_ENABLED is set or a durable broker is configured (AMQP_URL) - a
  // distributed deployment wants events that survive a crash between commit and
  // publish. In the default in-process monolith it stays off, so emit() keeps its
  // synchronous fan-out and emitInTransaction() guides callers to enable it.
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
  // Client-facing realtime push (chat, live feeds): default in-process fan-out
  // served as SSE; an overlay rebinds REALTIME_TRANSPORT to a managed vendor
  // (Ably/GetStream) without touching modules. See ADR-0007.
  container.register(REALTIME_TRANSPORT, () => new InProcessRealtimeTransport());
  // Client connection provisioning - the complement to REALTIME_TRANSPORT. The
  // default is first-party SSE (no token; the session cookie authorizes the
  // event-iterator stream). A managed-vendor overlay (Ably/GetStream) rebinds
  // REALTIME_CLIENT_AUTHORIZER to mint a per-player scoped token. See ADR-0007.
  container.register(REALTIME_CLIENT_AUTHORIZER, () => new SseClientAuthorizer());
  // Background jobs: default in-process queue (zero deps); an overlay rebinds
  // JOB_QUEUE to a durable driver (the BullMQ/Redis overlay). The disposer drains
  // in-flight jobs on shutdown - registered after DRIZZLE's (below) so it runs
  // first (disposers run in reverse), i.e. workers finish before the DB closes.
  container.register(JOB_QUEUE, () => {
    const q = new InProcessJobQueue(createLogger('job-queue'));
    container.onDispose(() => q.close());
    return q;
  });
  // One shared better-auth instance verifies the session cookie for both the
  // per-request identity middleware (below) and the AdminGuard - no second
  // createAuth() over the same DB. The better-auth schema lives in the
  // @oss-addons/identity add-on, so it is injected here where it is already imported.
  container.register(
    AUTH_SESSION,
    (c) => new SessionResolver(c.get(DRIZZLE), { user, session, account, verification, twoFactor }),
  );
  container.register(
    ADMIN_GUARD,
    (c) =>
      new AdminGuard(
        c.get(DRIZZLE),
        c.get(AUTH_SESSION),
        // Optional: bound only when a backoffice iam module registers it. has()
        // avoids throwing on an unbound token so boot works without the module.
        c.has(ADMIN_PERMISSION_RESOLVER) ? c.get(ADMIN_PERMISSION_RESOLVER) : undefined,
      ),
  );
  if (config.igaming) {
    const igaming = config.igaming;
    container.register(IGAMING_CONFIG, () => igaming);
  }

  const registry = await loadPlugins(config.plugins, container);
  await config.configure?.(container);

  // Subscribe every plugin-registered handler to the resolved bus. Plugins collect
  // handlers via ctx.events.on(...) during register(); this is where they go live.
  const bus = container.get(EVENT_BUS);
  for (const [event, handlers] of registry.events.getAll()) {
    for (const handler of handlers) {
      bus.on(event, handler);
    }
  }

  // Start background-job workers collected by plugins (ctx.jobs.worker(...)).
  // Resolve DRIZZLE first so its dispose runs AFTER the queue's drain (reverse
  // order); resolve JOB_QUEUE last so an overlay's durable driver is in effect.
  const drizzle = container.get(DRIZZLE);
  const jobQueue = container.get(JOB_QUEUE);
  for (const registration of registry.jobs.getAll()) {
    jobQueue.registerWorker(registration);
  }

  // Start the outbox relay (when enabled): it polls pending event_outbox rows and
  // publishes them to the broker. Disposed before the DB closes (reverse order).
  if (outboxEnabled) {
    // System path: the relay scans event_outbox across all tenants, so it uses
    // the BYPASSRLS admin db and never sets app.tenant_id (ADR-0018).
    const relay = new OutboxRelay(drizzle.adminDb, container.get(MESSAGE_BROKER), {
      onError: (err) => createLogger('outbox-relay').error({ err }, 'outbox drain failed'),
    });
    relay.start();
    container.onDispose(() => relay.stop());
  }

  // Assemble the root oRPC router from each plugin's router factory, keyed by the
  // module's contract namespace. Built once, after every plugin has registered.
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
        if (!(error instanceof ORPCError)) {
          console.error('[oRPC unhandled]', error);
        }
      }),
    ],
  });

  const app = new Hono();

  if (config.cors !== false) {
    const origins =
      config.cors === true || config.cors === undefined ? undefined : config.cors.origins;
    app.use('/*', cors({ origin: origins ?? ((origin) => origin), credentials: true }));
  }

  // The shared session resolver verifies the better-auth cookie once per request.
  const sessions = container.get(AUTH_SESSION);

  app.use('/*', async (c, next) => {
    const headers = headersToRecord(c.req.raw.headers);
    const context: OssContext = { request: { headers } };

    // Identify the caller from the VERIFIED better-auth session cookie - never from
    // a client-supplied `x-user-id` header (W1, ADR-0019). Then resolve the tenant
    // server-side from that verified user (ADR-0018) and run the whole request
    // inside both the tenant AsyncLocalStorage (for event correlation) AND a
    // request-pinned RLS connection (so every this.db query is scoped by RLS).
    const userId = await sessions.resolveUserId(c.req.raw.headers);
    const tenantId = userId ? await resolveTenantForUser(drizzle, userId) : undefined;

    const runHandler = async (): Promise<Response> => {
      const { matched, response } = await handler.handle(c.req.raw, { context });
      if (matched) return c.newResponse(response.body, response);
      await next();
      return c.res;
    };

    if (!userId || !tenantId) {
      // No valid session (or no resolvable tenant): context.auth stays undefined,
      // so getUserId/getTenantId 401, and no tenant GUC is set, so the RLS app role
      // sees zero rows on any scoped table (fail-closed). Auth/public routes only
      // touch non-scoped tables on the admin path, so they still work.
      return runHandler();
    }

    // Publish the VERIFIED identity onto the oRPC context for getUserId/getTenantId.
    context.auth = { userId, tenantId };

    const traceId = headers['x-trace-id'] ?? randomUUID();
    return withTenant({ userId, tenantId, traceId }, () =>
      drizzle.runWithTenant(tenantId, runHandler),
    );
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
      if (config.openapi?.enabled === false) return null;
      const outPath = await generateOpenApiSpec(config.contract ?? defaultContract, {
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

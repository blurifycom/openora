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
  withRequestContext,
  EVENT_BUS,
  type OssContext,
} from '../kernel/index.js';
import { randomUUID } from 'node:crypto';
import {
  MESSAGE_BROKER,
  JOB_QUEUE,
  REALTIME_TRANSPORT,
  REALTIME_CLIENT_AUTHORIZER,
  OUTBOX,
  ADMIN_PERMISSION_RESOLVER,
} from '../../contracts/adapters/index.js';
import { DrizzleService, DRIZZLE, DrizzleOutboxWriter, OutboxRelay } from '../db/index.js';
import { AdminGuard, ADMIN_GUARD, SessionResolver, AUTH_SESSION } from '../auth/index.js';
import { loadPlugins, type PluginEntry } from '../plugin-host/index.js';
import { composeContract, healthContract } from '../../contracts/orpc/index.js';
import { IGAMING_CONFIG, type IgamingConfig } from '../../contracts/schemas/index.js';

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

  configure?: (container: Container) => void | Promise<void>;

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

  const container = new Container();
  container.register(DRIZZLE, () => {
    const svc = new DrizzleService();
    container.onDispose(() => svc.dispose());
    return svc;
  });
  container.register(MESSAGE_BROKER, () => {
    const broker = new InMemoryBroker();
    container.onDispose(() => broker.close());
    return broker;
  });
  // Enabled when OUTBOX_ENABLED is set or a durable broker is configured (AMQP_URL) -
  // a distributed deployment wants events that survive a crash between commit and
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
  // Default in-process fan-out served as SSE; an overlay rebinds to a managed
  // vendor (Ably/GetStream) without touching modules. See ADR-0007.
  container.register(REALTIME_TRANSPORT, () => new InProcessRealtimeTransport());
  // Default is first-party SSE (no token; the session cookie authorizes the stream).
  // A managed-vendor overlay rebinds this to mint a per-player scoped token. See ADR-0007.
  container.register(REALTIME_CLIENT_AUTHORIZER, () => new SseClientAuthorizer());
  // Default in-process queue (zero deps); an overlay rebinds to BullMQ/Redis.
  // Disposer drains in-flight jobs before the DB closes (disposers run in reverse).
  container.register(JOB_QUEUE, () => {
    const q = new InProcessJobQueue(createLogger('job-queue'));
    container.onDispose(() => q.close());
    return q;
  });
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
      ),
  );
  if (config.igaming) {
    const igaming = config.igaming;
    container.register(IGAMING_CONFIG, () => igaming);
  }

  const registry = await loadPlugins(config.plugins, container);
  await config.configure?.(container);

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

  const sessions = container.get(AUTH_SESSION);

  app.use('/*', async (c, next) => {
    const headers = headersToRecord(c.req.raw.headers);
    const context: OssContext = { request: { headers } };

    // Never identify from a client-supplied `x-user-id` header (W1, ADR-0019).
    const userId = await sessions.resolveUserId(c.req.raw.headers);

    const runHandler = async (): Promise<Response> => {
      const { matched, response } = await handler.handle(c.req.raw, { context });
      if (matched) return c.newResponse(response.body, response);
      await next();
      return c.res;
    };

    const traceId = headers['x-trace-id'] ?? randomUUID();

    if (!userId) {
      // No valid session - context.auth stays undefined so getUserId 401s. Auth and
      // public routes still work. Run inside the request context for trace correlation.
      return withRequestContext({ traceId }, runHandler);
    }

    context.auth = { userId };

    return withRequestContext({ userId, traceId }, runHandler);
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

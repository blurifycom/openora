import { OpenAPIGenerator } from '@orpc/openapi';
import { OpenAPIHandler } from '@orpc/openapi/fetch';
import { implement, onError, ORPCError, type AnyRouter } from '@orpc/server';
import { ResponseHeadersPlugin } from '@orpc/server/plugins';
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4';
import type { ContractRouter } from '@orpc/contract';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve, type ServerType } from '@hono/node-server';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  Container,
  InMemoryBroker,
  InProcessJobQueue,
  InProcessRealtimeTransport,
  createEventBus,
  createLogger,
  EVENT_BUS,
  type OssContext,
} from '@oss/core';
import { MESSAGE_BROKER, JOB_QUEUE, REALTIME_TRANSPORT } from '@oss/adapters';
import { DrizzleService, DRIZZLE } from '@oss/db';
import { AdminGuard, ADMIN_GUARD } from '@oss/auth';
import { loadPlugins, type PluginEntry } from '@oss/plugin-host';
import { contract as defaultContract, healthContract } from '@oss/orpc-contract';
import { IGAMING_CONFIG, type IgamingConfig } from '@oss/shared-schemas';

export interface CreateAppConfig {
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
  // Consumers can compose the OSS contract with their own extensions.
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
}

export interface CreatedApp {
  app: Hono;
  container: Container;
  port: number;
  listen(): Promise<void>;
  emitOpenApiSpec(): Promise<string | null>;
  close(): Promise<void>;
}

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
  container.register(MESSAGE_BROKER, () => new InMemoryBroker());
  container.register(EVENT_BUS, (c) =>
    createEventBus(c.get(MESSAGE_BROKER), createLogger('event-bus')),
  );
  // Client-facing realtime push (chat, live feeds): default in-process fan-out
  // served as SSE; an overlay rebinds REALTIME_TRANSPORT to a managed vendor
  // (Ably/GetStream) without touching modules. See ADR-0007.
  container.register(REALTIME_TRANSPORT, () => new InProcessRealtimeTransport());
  // Background jobs: default in-process queue (zero deps); an overlay rebinds
  // JOB_QUEUE to a durable driver (the BullMQ/Redis overlay). The disposer drains
  // in-flight jobs on shutdown - registered after DRIZZLE's (below) so it runs
  // first (disposers run in reverse), i.e. workers finish before the DB closes.
  container.register(JOB_QUEUE, () => {
    const q = new InProcessJobQueue(createLogger('job-queue'));
    container.onDispose(() => q.close());
    return q;
  });
  container.register(ADMIN_GUARD, (c) => new AdminGuard(c.get(DRIZZLE)));
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
  container.get(DRIZZLE);
  const jobQueue = container.get(JOB_QUEUE);
  for (const registration of registry.jobs.getAll()) {
    jobQueue.registerWorker(registration);
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
    app.use(
      '/*',
      cors({ origin: origins ?? ((origin) => origin), credentials: true }),
    );
  }

  app.use('/*', async (c, next) => {
    const context: OssContext = { request: { headers: headersToRecord(c.req.raw.headers) } };
    const { matched, response } = await handler.handle(c.req.raw, { context });
    if (matched) {
      return c.newResponse(response.body, response);
    }
    await next();
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
      const contract = config.contract ?? defaultContract;
      const generator = new OpenAPIGenerator({
        schemaConverters: [new ZodToJsonSchemaConverter()],
      });
      const spec = await generator.generate(contract, {
        info: {
          title: config.openapi?.info?.title ?? 'OSS Igaming API',
          version: config.openapi?.info?.version ?? '0.0.1',
        },
      });
      const outPath = config.openapi?.outputPath ?? resolve(process.cwd(), 'docs/openapi.json');
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, JSON.stringify(spec, null, 2) + '\n', 'utf8');
      process.stdout.write(`OpenAPI spec written to ${outPath}\n`);
      return outPath;
    },
    async close() {
      server?.close();
      await container.dispose();
    },
  };
}

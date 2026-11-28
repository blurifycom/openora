import { OpenAPIHandler } from '@orpc/openapi/fetch';
import { OpenAPIReferencePlugin } from '@orpc/openapi/plugins';
import { implement, onError, ORPCError, type AnyRouter } from '@orpc/server';
import { ResponseHeadersPlugin } from '@orpc/server/plugins';
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { etag } from 'hono/etag';
import { HTTPException } from 'hono/http-exception';
import { serve, type ServerType } from '@hono/node-server';
import {
  Container,
  BullMqJobQueue,
  RedisCache,
  RedisRateLimiter,
  RedisStreamsBroker,
  streamStartIdFromEnv,
  RedisPubSubRealtimeTransport,
  SseClientAuthorizer,
  createEventBus,
  createLogger,
  createRedisClient,
  withRequestContext,
  setErrorReporter,
  EVENT_BUS,
  extractClientMeta,
  type InternalContext,
  type OssContext,
} from '../kernel/index.js';
import { randomUUID } from 'node:crypto';
import {
  MESSAGE_BROKER,
  JOB_QUEUE,
  OUTBOX,
  ADMIN_PERMISSION_RESOLVER,
  ADMIN_SECURITY_POLICY,
  ACCOUNT_READER,
  playerIdsOf,
  AUDIT_WRITER,
  IDENTITY_READER,
  MCP_KERNEL,
  MCP_TOKEN_AUTHENTICATOR,
  RATE_LIMITER,
  CACHE,
  REALTIME_TRANSPORT,
  REALTIME_CLIENT_AUTHORIZER,
  ERROR_TRACKING,
  healthContract,
  IGAMING_CONFIG,
  type IgamingConfig,
  type McpKernel,
  PLATFORM_CONFIG,
  PLAYER_ACTIVITY_TRACKER,
  SESSION_IDLE_POLICY,
  TWO_FACTOR_SETUP_POLICY,
} from '@openora/core/contracts';
import {
  DrizzleService,
  DRIZZLE,
  DrizzleOutboxWriter,
  DrizzleProcessedEventLog,
  OutboxRelay,
} from '../db/index.js';
import {
  AdminGuard,
  ADMIN_GUARD,
  SessionResolver,
  AUTH_SESSION,
  LOCAL_SESSION_RESOLVER,
  REMOTE_SESSION_RESOLVER,
  resolveSessionChain,
  type RequestSessionResolver,
} from '../auth/index.js';
import { loadPlugins, parseServiceManifest, type PluginEntry } from '../plugin-host/index.js';
import { importPlugin } from '../plugin-host/load-plugins.js';
import { withoutRemoteModules } from '../plugin-host/remote-modules.js';
import {
  assertServiceComplete,
  selectServiceEntries,
  type HostControl,
  type ServiceManifestCheck,
} from '../plugin-host/service-manifest.js';
import { allowedTriggers, createMcpKernel } from '../mcp/index.js';
import { authorizeWithAdminGuard } from '../mcp/authorize.js';
import type { McpHttpTransport } from '../mcp/http-transport.js';
import { payloadTooLarge } from '../mcp/transport-gate.js';
import { adminMutationAudit } from './admin-mutation-audit.js';
import { assertDurableSeamsBound } from './assert-durable-seams.js';
import { startTelemetry } from './telemetry.js';
import {
  applyClientAddress,
  resolveTrustedProxies,
  type TrustedProxies,
} from './client-address.js';
import { loadPlatformConfig, resolvePlatformConfigPath } from '../kernel/platform-config-loader.js';
import { wireErrorBody } from '../kernel/wire-error-response.js';
import type { CoreTokenCatalog } from './core-token-catalog.js';
import { parseJobWorkers, selectJobWorkers } from './job-workers.js';
import {
  INTERNAL_API_PREFIX,
  INTERNAL_API_SESSION_HEADERS,
  type InternalRefusalReason,
  isSignedBy,
  parseInternalApiSecrets,
  readSignatureHeaders,
} from './internal-api.js';

export const PUBLIC_HTTP_CACHE_PATHS = ['/cms/pages', '/gaming/games'] as const;

const DEFAULT_HTTP_CACHE_MAX_AGE_SECONDS = 30;
const DEFAULT_HTTP_CACHE_STALE_WHILE_REVALIDATE_SECONDS = 60;

const DEFAULT_MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;

function resolveCorsOrigins(cors: CreateAppConfig['cors']): string[] | undefined {
  if (cors === false) {
    return undefined;
  }
  const configured = cors?.origins ?? process.env['CORS_ORIGINS']?.split(',') ?? [];
  const origins = [configured]
    .flat()
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  if (origins.length === 0) {
    throw new Error(
      '[create-app] No CORS origins configured. Set CORS_ORIGINS to the comma-separated ' +
        'origins of the apps that call this API (eg https://app.example.com,https://admin.example.com), ' +
        'pass `cors: { origins }`, or pass `cors: false` to send no CORS headers at all.',
    );
  }
  if (origins.includes('*')) {
    throw new Error(
      "[create-app] '*' is not a CORS origin any more. List the exact origins that call this " +
        'API, or pass `cors: false` to send no CORS headers at all.',
    );
  }
  return origins;
}

function resolveServiceName(): string {
  const serviceName = process.env['SERVICE_NAME'];
  if (serviceName) {
    return serviceName;
  }
  if (parseServiceManifest(process.env['SERVICE_MANIFEST']) !== null) {
    throw new Error(
      '[create-app] SERVICE_MANIFEST is set but SERVICE_NAME is not. A split service needs a stable ' +
        'name of its own: it becomes the MESSAGE_BROKER consumer group, and every service sharing a ' +
        'group competes for the same events instead of each receiving a copy. Set SERVICE_NAME to a ' +
        'stable identifier for this deployment (eg SERVICE_NAME=wallet).',
    );
  }
  return 'monolith';
}

function resolveRealtimeNamespace(serviceName: string): string {
  const namespace = process.env['REALTIME_NAMESPACE'];
  if (namespace) {
    return namespace;
  }
  if (parseServiceManifest(process.env['SERVICE_MANIFEST']) !== null) {
    throw new Error(
      '[create-app] SERVICE_MANIFEST is set but REALTIME_NAMESPACE is not. A split service would ' +
        'fall back to its own name, so its channels, signals, presence and session revocation ' +
        'would silently diverge from the other services of the deployment. Set REALTIME_NAMESPACE ' +
        'to the identity shared by every service of this deployment (eg REALTIME_NAMESPACE=casino).',
    );
  }
  return serviceName;
}

export type CreateAppConfig = {
  plugins: PluginEntry[];

  authSchema?: Record<string, unknown>;

  port?: number;

  cors?: false | { origins: string | readonly string[] };

  bodyLimit?: false | { maxBytes: number };

  databaseUrl?: string;

  igaming?: IgamingConfig;

  httpCache?: { paths?: string[]; additionalPaths?: string[]; maxAgeSeconds?: number } | false;

  disableHealthModule?: boolean;

  telemetry?: false;

  trustedProxies?: readonly string[];
};

export type CreatedApp = {
  app: Hono;
  container: Container<CoreTokenCatalog>;
  port: number;
  listen(): Promise<void>;
  close(): Promise<void>;
};

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function requestMeta(c: Context, trustedProxies: TrustedProxies) {
  const headers = headersToRecord(c.req.raw.headers);
  const remoteAddress = (c.env as { incoming?: { socket?: { remoteAddress?: string } } })?.incoming
    ?.socket?.remoteAddress;
  applyClientAddress(headers, remoteAddress, trustedProxies);
  return {
    headers,
    clientMeta: extractClientMeta(headers),
    traceId: headers['x-trace-id'] ?? randomUUID(),
  };
}

const ADMIN_GUARD_CONTROLS = [
  {
    owner: 'AdminGuard',
    port: ADMIN_PERMISSION_RESOLVER,
    boundBy: 'iam',
    without:
      'grants come from the static role table, so an admin whose role was revoked still acts',
  },
  {
    owner: 'AdminGuard',
    port: ADMIN_SECURITY_POLICY,
    boundBy: 'identity',
    without: 'admins skip the 2FA enrolment and session-integrity checks',
  },
] as const satisfies readonly HostControl<CoreTokenCatalog>[];

const MCP_MAX_BODY_BYTES = 1_048_576;
const MCP_SDK_PACKAGE = '@modelcontextprotocol/sdk';

type MountedMcpTransport = { path: string; transport: McpHttpTransport };

function causeChain(err: unknown) {
  const chain: Error[] = [];
  for (
    let current = err;
    current instanceof Error && !chain.includes(current);
    current = current.cause
  ) {
    chain.push(current);
  }
  return chain;
}

function isMissingMcpSdk(err: unknown) {
  return causeChain(err).some(
    (link) =>
      'code' in link &&
      link.code === 'ERR_MODULE_NOT_FOUND' &&
      link.message.includes(MCP_SDK_PACKAGE),
  );
}

async function importMcpHttpTransport() {
  try {
    return await import('../mcp/http-transport.js');
  } catch (err) {
    if (!isMissingMcpSdk(err)) {
      throw err;
    }
    throw new Error(
      `[create-app] agents.mcp.enabled is on, but ${MCP_SDK_PACKAGE} is not installed. ` +
        `@openora/core declares it as an optional peer dependency: install it, ` +
        `or turn agents.mcp.enabled off.`,
      { cause: err },
    );
  }
}

async function loadMcpTransport(container: Container<CoreTokenCatalog>, kernel: McpKernel) {
  const config = container.get(PLATFORM_CONFIG).agents.mcp;
  if (!config.enabled) {
    return null;
  }
  const missing = [
    {
      name: 'MCP_TOKEN_AUTHENTICATOR',
      bound: container.has(MCP_TOKEN_AUTHENTICATOR),
      fix: 'load the iam module, which binds it',
    },
    {
      name: 'AUDIT_WRITER',
      bound: container.has(AUDIT_WRITER),
      fix: 'load the audit module - the kernel refuses every call it cannot audit',
    },
  ].filter((seam) => !seam.bound);
  if (missing.length > 0) {
    throw new Error(
      '[create-app] agents.mcp.enabled is on, but the MCP transport has no binding for:\n' +
        missing.map((seam) => `  - ${seam.name}: ${seam.fix}`).join('\n') +
        '\nBind them, or turn agents.mcp.enabled off.',
    );
  }
  const { createMcpHttpTransport } = await importMcpHttpTransport();
  return {
    path: config.path,
    transport: createMcpHttpTransport({
      kernel,
      authenticator: container.get(MCP_TOKEN_AUTHENTICATOR),
      adminGuard: container.get(ADMIN_GUARD),
      rateLimiter: container.get(RATE_LIMITER),
      audit: container.get(AUDIT_WRITER),
      config,
    }),
  };
}

function mountMcpTransport(
  app: Hono,
  { path, transport }: MountedMcpTransport,
  trustedProxies: TrustedProxies,
) {
  const limitBody = bodyLimit({ maxSize: MCP_MAX_BODY_BYTES, onError: () => payloadTooLarge() });
  app.all(path, async (c, next) => {
    if (!transport.servesHost(new URL(c.req.url).hostname)) {
      return next();
    }
    const { clientMeta, traceId } = requestMeta(c, trustedProxies);
    const refused = await limitBody(c, async () => {
      c.res = await withRequestContext({ traceId, clientMeta }, () =>
        transport.handle(c.req.raw, clientMeta),
      );
    });
    return refused ?? c.res;
  });
}

const MAX_CAPTURED_BODY_BYTES = 1_048_576;

async function readBoundedBody(req: Request): Promise<Buffer | undefined> {
  if (!req.body) {
    return Buffer.alloc(0);
  }
  const declaredLength = req.headers.get('content-length');
  if (declaredLength && Number(declaredLength) > MAX_CAPTURED_BODY_BYTES) {
    return undefined;
  }
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
        reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

async function captureRawBody(req: Request): Promise<string | undefined> {
  if (!req.body) {
    return undefined;
  }
  return (await readBoundedBody(req))?.toString('utf8');
}

type InternalApiMount = {
  handler: OpenAPIHandler<OssContext>;
  secrets: readonly string[];
  audience: string;
  trustedProxies: TrustedProxies;
};

function mountInternalApi(
  app: Hono,
  { handler, secrets, audience, trustedProxies }: InternalApiMount,
) {
  const logger = createLogger('internal-api');
  app.all(`${INTERNAL_API_PREFIX}/*`, async (c) => {
    const url = new URL(c.req.url);
    const refuse = (reason: InternalRefusalReason, service: string | null = null) => {
      logger.warn(
        { service, method: c.req.method, path: url.pathname, reason },
        'internal call refused',
      );
      return c.body(null, reason === 'body_too_large' ? 413 : 401);
    };
    if (secrets.length === 0) {
      return refuse('disabled');
    }
    const signature = readSignatureHeaders(c.req.raw.headers, Date.now());
    if (typeof signature === 'string') {
      return refuse(signature);
    }
    const body = await readBoundedBody(c.req.raw);
    if (body === undefined) {
      return refuse('body_too_large', signature.service);
    }
    const content = {
      audience,
      method: c.req.method,
      pathAndQuery: `${url.pathname}${url.search}`,
      contentType: c.req.header('content-type') ?? '',
      body,
    };
    if (!isSignedBy(signature, content, secrets)) {
      return refuse('bad_signature', signature.service);
    }
    const { headers, clientMeta, traceId } = requestMeta(c, trustedProxies);
    for (const name of INTERNAL_API_SESSION_HEADERS) {
      delete headers[name];
    }
    const context: InternalContext = {
      request: { headers },
      clientMeta,
      rawBody: body.toString('utf8'),
      internalCaller: signature.service,
    };
    return withRequestContext({ traceId, clientMeta }, async () => {
      const { matched, response } = await handler.handle(c.req.raw, {
        prefix: INTERNAL_API_PREFIX,
        context,
      });
      return matched ? c.newResponse(response.body, response) : c.body(null, 404);
    });
  });
}

function reportServerFault(error: unknown) {
  if (
    error instanceof ORPCError &&
    (error.status < 500 || (wireErrorBody(error) !== null && error.cause === undefined))
  ) {
    return;
  }
  const err = error instanceof ORPCError ? (error.cause ?? error) : error;
  createLogger('orpc').error({ err }, 'unhandled error');
}

export async function createApp(
  config: CreateAppConfig,
  configure?: (container: Container<CoreTokenCatalog>) => void | Promise<void>,
): Promise<CreatedApp> {
  const container = new Container<CoreTokenCatalog>();
  try {
    return await bootApp(container, config, configure);
  } catch (err) {
    await container
      .dispose()
      .catch((disposeErr: unknown) =>
        createLogger('create-app').error({ err: disposeErr }, 'closing a failed boot failed'),
      );
    throw err;
  }
}

async function bootApp(
  container: Container<CoreTokenCatalog>,
  config: CreateAppConfig,
  configure?: (container: Container<CoreTokenCatalog>) => void | Promise<void>,
) {
  const trustedProxies = resolveTrustedProxies(
    config.trustedProxies,
    process.env['TRUSTED_PROXIES'],
  );
  const jobWorkerSelection = parseJobWorkers(process.env['JOB_WORKERS']);
  const internalApiSecrets = parseInternalApiSecrets(process.env['INTERNAL_API_SECRETS']);
  const manifest = parseServiceManifest(process.env['SERVICE_MANIFEST']);

  if (config.databaseUrl) {
    process.env['DATABASE_URL'] = config.databaseUrl;
  }

  container.register(DRIZZLE, () => {
    const svc = new DrizzleService();
    container.onDispose(() => svc.dispose());
    return svc;
  });
  container.register(OUTBOX, () => new DrizzleOutboxWriter());
  container.register(EVENT_BUS, (c) =>
    createEventBus({
      broker: c.get(MESSAGE_BROKER),
      outbox: c.get(OUTBOX),
      processedEvents: new DrizzleProcessedEventLog(c.get(DRIZZLE).db),
      logger: createLogger('event-bus'),
    }),
  );
  const serviceName = resolveServiceName();
  const realtimeNamespace = resolveRealtimeNamespace(serviceName);
  const redisUrl = process.env['REDIS_URL'];
  if (redisUrl) {
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
      const broker = new RedisStreamsBroker(redis, {
        serviceName,
        startId: streamStartIdFromEnv(
          process.env['EVENT_BUS_START_ID'],
          parseServiceManifest(process.env['SERVICE_MANIFEST']) !== null,
        ),
      });
      container.onDispose(() => broker.close());
      return broker;
    });
    container.register(REALTIME_TRANSPORT, () => {
      const transport = new RedisPubSubRealtimeTransport(redis, realtimeNamespace);
      container.onDispose(() => transport.close());
      return transport;
    });
    container.register(REALTIME_CLIENT_AUTHORIZER, () => new SseClientAuthorizer());
  }
  container.register(AUTH_SESSION, (c) => new SessionResolver(c.get(DRIZZLE), config.authSchema));
  container.register(
    LOCAL_SESSION_RESOLVER,
    (c): RequestSessionResolver => ({
      resolve: (headers) =>
        resolveSessionChain(
          () => ({
            sessions: c.get(AUTH_SESSION),
            idlePolicy: c.has(SESSION_IDLE_POLICY) ? c.get(SESSION_IDLE_POLICY) : undefined,
            twoFactorPolicy: c.has(TWO_FACTOR_SETUP_POLICY)
              ? c.get(TWO_FACTOR_SETUP_POLICY)
              : undefined,
            activity: c.has(PLAYER_ACTIVITY_TRACKER) ? c.get(PLAYER_ACTIVITY_TRACKER) : undefined,
          }),
          headers,
        ),
    }),
  );
  container.register(
    ADMIN_GUARD,
    (c) =>
      new AdminGuard(
        c.get(DRIZZLE),
        c.has(REMOTE_SESSION_RESOLVER) ? undefined : c.get(AUTH_SESSION),
        c.has(ADMIN_PERMISSION_RESOLVER) ? c.get(ADMIN_PERMISSION_RESOLVER) : undefined,
        c.get(EVENT_BUS),
        c.has(ACCOUNT_READER)
          ? playerIdsOf(c.get(ACCOUNT_READER), createLogger('create-app'))
          : c.has(IDENTITY_READER)
            ? c.get(IDENTITY_READER)
            : undefined,
        c.has(ADMIN_SECURITY_POLICY) ? c.get(ADMIN_SECURITY_POLICY) : undefined,
        c.has(ACCOUNT_READER) ? c.get(ACCOUNT_READER) : undefined,
      ),
  );
  if (config.igaming) {
    const igaming = config.igaming;
    container.register(IGAMING_CONFIG, () => igaming);
  }
  container.register(PLATFORM_CONFIG, () => loadPlatformConfig(resolvePlatformConfigPath()));

  const corsOrigins = resolveCorsOrigins(config.cors);

  const bootLogger = createLogger('create-app');
  const { entries: registryEntries, dropped: droppedForRemote } = await withoutRemoteModules(
    config.plugins,
    importPlugin<CoreTokenCatalog>,
  );
  for (const { env, modules } of droppedForRemote) {
    bootLogger.info({ modules }, `${env} is set: not loading these modules here`);
  }
  const manifestCheck: ServiceManifestCheck<CoreTokenCatalog> | null =
    manifest === null
      ? null
      : {
          entries: registryEntries,
          manifest,
          readPlugin: (entry) => importPlugin(entry),
          hostControls: ADMIN_GUARD_CONTROLS,
          isBound: (port) => container.has(port),
        };
  const plugins = manifestCheck ? await selectServiceEntries(manifestCheck) : registryEntries;
  if (manifestCheck) {
    bootLogger.info(
      { modules: plugins.map((e) => (e.noRoutes ? `${e.id} (required only)` : e.id)) },
      'SERVICE_MANIFEST active',
    );
  }

  const registry = await loadPlugins(plugins, container, {
    requiredPorts: manifestCheck ? 'defer' : 'assert',
  });
  if (manifestCheck) {
    const notConsumed: Record<string, Record<string, number>> = {};
    for (const { owner, kind } of registry.withheld()) {
      const counts = (notConsumed[owner] ??= {});
      counts[kind] = (counts[kind] ?? 0) + 1;
    }
    if (Object.keys(notConsumed).length > 0) {
      bootLogger.warn(
        { notConsumed },
        'SERVICE_MANIFEST: these handlers run only where another process selects their module',
      );
    }
  }
  await configure?.(container);

  assertDurableSeamsBound(container);
  if (manifestCheck) {
    await assertServiceComplete({
      ...manifestCheck,
      registered: new Set(plugins.map(({ id }) => id)),
    });
    container.get(ADMIN_GUARD);
  }

  container.closeSealedTokens();

  container.registerSealed(MCP_KERNEL, (c) =>
    createMcpKernel({
      tools: registry.mcp.getTools(),
      actions: registry.actions.getAll(),
      container: c,
      authorize: (adminId, iam) => authorizeWithAdminGuard(c.get(ADMIN_GUARD), adminId, iam),
      audit: c.has(AUDIT_WRITER) ? c.get(AUDIT_WRITER) : null,
      triggerTopics: c.get(PLATFORM_CONFIG).agents.triggers.topics,
    }),
  );

  if (container.has(ERROR_TRACKING)) {
    const tracker = container.get(ERROR_TRACKING);
    setErrorReporter((error, context) => tracker.captureException(error, context));
    container.onDispose(() => setErrorReporter(undefined));
  }

  const bus = container.get(EVENT_BUS);
  for (const [event, handlers] of registry.events.getAll()) {
    for (const { handler, consumer, consumerGroup } of handlers) {
      bus.on(
        event,
        handler,
        consumerGroup
          ? { consumer, consumerGroup: `${realtimeNamespace}/${consumerGroup}` }
          : { consumer: `${serviceName}/${consumer}` },
      );
    }
  }
  const triggerListeners = registry.triggers.getAll();
  if (triggerListeners.length > 0) {
    for (const trigger of allowedTriggers(container.get(PLATFORM_CONFIG).agents.triggers.topics)) {
      for (const { owner, listener } of triggerListeners) {
        bus.on(trigger.topic, (payload, envelope) => {
          if (!envelope) {
            createLogger('agent-triggers').error(
              { topic: trigger.topic, owner },
              'agent trigger dropped - the event arrived without its envelope',
            );
            return;
          }
          return listener(trigger, payload, envelope);
        });
      }
    }
  }

  const drizzle = container.get(DRIZZLE);
  const jobQueue = container.get(JOB_QUEUE);

  const router: Record<string, AnyRouter> = {};
  for (const [namespace, factory] of registry.routers.getAll()) {
    if (namespace in router) {
      throw new Error(`Router namespace "${namespace}" is registered by more than one plugin`);
    }
    router[namespace] = factory(container) as AnyRouter;
  }
  const internalRouter: Record<string, AnyRouter> = {};
  for (const [namespace, factory] of registry.routers.getInternal()) {
    internalRouter[namespace] = factory(container) as AnyRouter;
  }
  if (Object.keys(internalRouter).length > 0 && internalApiSecrets.length === 0) {
    bootLogger.warn(
      { namespaces: Object.keys(internalRouter) },
      'INTERNAL_API_SECRETS is unset: every /internal/v1 request is refused',
    );
  }
  const mcpTransport = await loadMcpTransport(container, container.get(MCP_KERNEL));

  const workers = selectJobWorkers(registry.jobs.getAll(), jobWorkerSelection);
  if (jobWorkerSelection !== null) {
    const queuesOf = (list: typeof workers.consumed) => [...new Set(list.map((w) => w.queue))];
    bootLogger.info(
      {
        consumed: queuesOf(workers.consumed),
        skipped: queuesOf(workers.skipped),
        idleExclusions: workers.idleExclusions,
      },
      'JOB_WORKERS active',
    );
  }
  for (const registration of workers.consumed) {
    jobQueue.registerWorker(registration);
  }

  const relay = new OutboxRelay(drizzle.db, container.get(MESSAGE_BROKER), {
    onError: (err) => createLogger('outbox-relay').error({ err }, 'outbox drain failed'),
  });
  relay.start();
  container.onDispose(() => relay.stop());

  startTelemetry(container, config.telemetry);

  if (!config.disableHealthModule) {
    const os = implement(healthContract).$context<OssContext>();
    router['health'] = os.router({
      ping: os.ping.handler(() => ({ status: 'ok' as const, timestamp: new Date().toISOString() })),
    }) as AnyRouter;
  }

  const handler = new OpenAPIHandler(router, {
    plugins: [
      new OpenAPIReferencePlugin({
        docsPath: '/docs',
        specPath: '/openapi.json',
        schemaConverters: [new ZodToJsonSchemaConverter()],
      }),
      new ResponseHeadersPlugin(),
    ],
    clientInterceptors: container.has(AUDIT_WRITER)
      ? [adminMutationAudit(container.get(AUDIT_WRITER))]
      : [],
    customErrorResponseBodyEncoder: wireErrorBody,
    interceptors: [onError(reportServerFault)],
  });

  const internalHandler = new OpenAPIHandler<OssContext>(internalRouter, {
    customErrorResponseBodyEncoder: wireErrorBody,
    interceptors: [onError(reportServerFault)],
  });

  const app = new Hono();

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

  mountInternalApi(app, {
    handler: internalHandler,
    secrets: internalApiSecrets,
    audience: serviceName,
    trustedProxies,
  });

  if (mcpTransport) {
    mountMcpTransport(app, mcpTransport, trustedProxies);
  }

  if (corsOrigins) {
    app.use('/*', cors({ origin: corsOrigins, credentials: true }));
  }

  if (config.bodyLimit !== false) {
    const configuredMax = config.bodyLimit?.maxBytes;
    if (
      configuredMax !== undefined &&
      !(Number.isSafeInteger(configuredMax) && configuredMax > 0)
    ) {
      throw new Error(
        `[create-app] bodyLimit.maxBytes must be a positive integer, got ${String(configuredMax)}. ` +
          'Pass `bodyLimit: false` to disable the cap explicitly.',
      );
    }
    app.use(
      '/*',
      bodyLimit({
        maxSize: config.bodyLimit?.maxBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES,
        onError: (c) => c.json({ error: 'Payload Too Large' }, 413),
      }),
    );
  }

  if (config.httpCache !== false) {
    const cachePaths = config.httpCache?.paths ?? [
      ...PUBLIC_HTTP_CACHE_PATHS,
      ...(config.httpCache?.additionalPaths ?? []),
    ];
    const maxAgeSeconds = config.httpCache?.maxAgeSeconds ?? DEFAULT_HTTP_CACHE_MAX_AGE_SECONDS;
    const staleWhileRevalidateSeconds = config.httpCache?.maxAgeSeconds
      ? maxAgeSeconds * 2
      : DEFAULT_HTTP_CACHE_STALE_WHILE_REVALIDATE_SECONDS;
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
      const isEventStream = (c.res.headers.get('content-type') ?? '').includes('text/event-stream');
      if (isEventStream) {
        c.res.headers.set('X-Accel-Buffering', 'no');
      }
      c.res.headers.set(
        'Cache-Control',
        isCacheable
          ? `public, max-age=${maxAgeSeconds}, stale-while-revalidate=${staleWhileRevalidateSeconds}`
          : isEventStream
            ? 'no-store, no-transform'
            : 'no-store',
      );
    });
  }

  const remoteSessions = container.has(REMOTE_SESSION_RESOLVER)
    ? container.get(REMOTE_SESSION_RESOLVER)
    : undefined;
  if (!remoteSessions) {
    container.get(AUTH_SESSION);
  }
  const sessions = remoteSessions ?? container.get(LOCAL_SESSION_RESOLVER);

  app.use('/*', async (c, next) => {
    const { headers, clientMeta, traceId } = requestMeta(c, trustedProxies);
    const context: OssContext = {
      request: { headers },
      clientMeta,
      rawBody: await captureRawBody(c.req.raw),
    };

    const { auth, sessionEndedReason, unavailable } = await sessions.resolve(c.req.raw.headers);
    if (auth) {
      context.auth = auth;
    }
    if (sessionEndedReason) {
      context.sessionEndedReason = sessionEndedReason;
    }
    if (unavailable) {
      context.sessionUnavailable = true;
    }

    const runHandler = async (): Promise<Response> => {
      const { matched, response } = await handler.handle(c.req.raw, { context });
      if (matched) {
        return c.newResponse(response.body, response);
      }
      await next();
      return c.res;
    };

    return withRequestContext(
      { ...(auth ? { userId: auth.userId } : {}), traceId, clientMeta: context.clientMeta },
      runHandler,
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
    async close() {
      server?.close();
      await container.dispose();
    },
  };
}

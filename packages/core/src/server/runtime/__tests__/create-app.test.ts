import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  MESSAGE_BROKER,
  JOB_QUEUE,
  CACHE,
  MCP_KERNEL,
  PLATFORM_CONFIG,
  RATE_LIMITER,
  PLAYER_ACTIVITY_TRACKER,
  definePlatformConfig,
  getEventVersion,
  type BrokerHandler,
  type DomainEventName,
  type EventEnvelope,
  type McpKernel,
  type MessageBrokerAdapter,
} from '@openora/core/contracts';
import { redisUrlForWorker } from '@openora/core/testing';
import { makeJobQueue, mock } from '../../../testing/mock.js';
import { ADMIN_GUARD, AUTH_SESSION, type SessionResolver } from '../../auth/index.js';
import {
  EVENT_BUS,
  createEventBus,
  type Container,
  type EventBus,
  type EventHandler,
} from '../../kernel/index.js';
import type { PluginEntry } from '../../plugin-host/index.js';
import { createApp } from '../create-app.js';
import type { CoreTokenCatalog } from '../core-token-catalog.js';
import { countedRegistrations } from './fixtures/counted-plugin.js';
import { FIXTURE_LIMITS } from './fixtures/limits-plugin.js';
import { heardTriggers } from './fixtures/trigger-listener-plugin.js';
import { getCurrentClientMeta } from '../../kernel/request-context.js';

// A syntactically valid but unreachable DB url - fine here because nothing in this
// suite ever runs a query: DrizzleService's pg.Pool connects lazily, and neither
// health.ping nor better-auth's getSession() touch the DB when the request carries
// no session cookie (getSessionFromCtx short-circuits on a missing cookie).
const DUMMY_DATABASE_URL = 'postgres://test:test@127.0.0.1:1/create_app_test';

const fixture = (name: string) =>
  fileURLToPath(new URL(`./fixtures/${name}-plugin.ts`, import.meta.url));

describe('createApp - distributed-only durable seams (ADR-0030)', () => {
  it('throws a clear, actionable error when no durable seam is bound', async () => {
    await expect(createApp({ plugins: [], databaseUrl: DUMMY_DATABASE_URL })).rejects.toThrow(
      /MESSAGE_BROKER.*JOB_QUEUE.*CACHE.*RATE_LIMITER/s,
    );
  });

  it('boots and serves once REDIS_URL auto-binds all four seams', async () => {
    const saved = process.env['REDIS_URL'];
    process.env['REDIS_URL'] = redisUrlForWorker();
    try {
      const created = await createApp({
        plugins: [],
        databaseUrl: DUMMY_DATABASE_URL,
      });

      for (const token of [MESSAGE_BROKER, JOB_QUEUE, CACHE, RATE_LIMITER]) {
        expect(created.container.has(token)).toBe(true);
      }
      const res = await created.app.request('/health');
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: 'ok' });

      const spec = await created.app.request('/openapi.json');
      expect(spec.status).toBe(200);
      expect(await spec.json()).toMatchObject({ openapi: expect.any(String) });

      const docs = await created.app.request('/docs');
      expect(docs.status).toBe(200);
      expect(await docs.text()).toContain('API Reference');

      await created.close();
    } finally {
      if (saved === undefined) {
        delete process.env['REDIS_URL'];
      } else {
        process.env['REDIS_URL'] = saved;
      }
    }
  });
});

describe('createApp - the MCP kernel binding', () => {
  it('serves its own kernel over a configure() binding and refuses a rebind after boot', async () => {
    const saved = process.env['REDIS_URL'];
    process.env['REDIS_URL'] = redisUrlForWorker();
    try {
      const imposter = mock<McpKernel>();
      const created = await createApp(
        { plugins: [], databaseUrl: DUMMY_DATABASE_URL },
        (container) => {
          container.register(MCP_KERNEL, () => imposter);
        },
      );
      const kernel = created.container.get(MCP_KERNEL);

      expect(kernel).not.toBe(imposter);
      expect(() => created.container.register(MCP_KERNEL, () => imposter)).toThrow(
        /Token "MCP_KERNEL" is sealed/,
      );
      expect(created.container.get(MCP_KERNEL)).toBe(kernel);

      await created.close();
    } finally {
      if (saved === undefined) {
        delete process.env['REDIS_URL'];
      } else {
        process.env['REDIS_URL'] = saved;
      }
    }
  });
});

describe('createApp - agent trigger listeners', () => {
  const saved = process.env['REDIS_URL'];
  const recording: PluginEntry = { id: 'trigger-listener', path: fixture('trigger-listener') };
  const throwing: PluginEntry = {
    id: 'throwing-trigger-listener',
    path: fixture('throwing-trigger-listener'),
  };

  afterEach(() => {
    heardTriggers().length = 0;
    if (saved === undefined) {
      delete process.env['REDIS_URL'];
    } else {
      process.env['REDIS_URL'] = saved;
    }
  });

  function bootWith(topics: DomainEventName[], plugins: PluginEntry[], bus: EventBus) {
    process.env['REDIS_URL'] = redisUrlForWorker();
    return createApp({ plugins, databaseUrl: DUMMY_DATABASE_URL }, (container) => {
      container.register(EVENT_BUS, () => bus);
      container.register(PLATFORM_CONFIG, () =>
        definePlatformConfig({ agents: { triggers: { topics } } }),
      );
    });
  }

  function subscriptionBus() {
    const subscribed = new Map<string, EventHandler[]>();
    const bus = mock<EventBus>({
      on: (topic: string, handler: EventHandler) => {
        subscribed.set(topic, [...(subscribed.get(topic) ?? []), handler]);
        return () => undefined;
      },
    });
    return { bus, subscribed };
  }

  function brokerBackedBus() {
    const subscribed = new Map<string, BrokerHandler[]>();
    const broker = mock<MessageBrokerAdapter>({
      subscribe: (topic: string, handler: BrokerHandler) => {
        subscribed.set(topic, [...(subscribed.get(topic) ?? []), handler]);
        return () => undefined;
      },
    });
    const logger = mock<Logger>({ error: vi.fn() });
    const deliver = async (envelope: EventEnvelope) => {
      for (const handler of subscribed.get(envelope.topic) ?? []) {
        await handler(envelope);
      }
    };
    return { bus: createEventBus(broker, logger), logger, deliver };
  }

  const loginEnvelope = (): EventEnvelope => ({
    eventId: randomUUID(),
    topic: 'identity.user.login',
    payload: { userId: randomUUID(), playerId: null },
    occurredAt: new Date().toISOString(),
    schemaVersion: getEventVersion('identity.user.login'),
  });

  it('subscribes a listener to the allow-listed topics only, and hands it the trigger', async () => {
    const { bus, subscribed } = subscriptionBus();
    const created = await bootWith(['promo.bonus.granted'], [recording], bus);
    const envelope = mock<EventEnvelope>({ eventId: 'event-1' });

    expect([...subscribed.keys()]).toEqual(['promo.bonus.granted']);
    for (const handler of subscribed.get('promo.bonus.granted') ?? []) {
      await handler({ userId: 'user-1' }, envelope);
    }
    expect(heardTriggers()).toEqual([
      {
        trigger: expect.objectContaining({ topic: 'promo.bonus.granted', subjectField: 'userId' }),
        payload: { userId: 'user-1' },
        envelope,
      },
    ]);
    expect(created.container.get(MCP_KERNEL).listTriggers()).toEqual([
      expect.objectContaining({ topic: 'promo.bonus.granted' }),
    ]);

    await created.close();
  });

  it('subscribes nothing for a listener while no topic is allow-listed', async () => {
    const { bus, subscribed } = subscriptionBus();
    const created = await bootWith([], [recording], bus);

    expect(subscribed.size).toBe(0);

    await created.close();
  });

  it('subscribes nothing to an allow-listed topic while no plugin listens', async () => {
    const { bus, subscribed } = subscriptionBus();
    const created = await bootWith(['promo.bonus.granted'], [], bus);

    expect(subscribed.size).toBe(0);
    expect(created.container.get(MCP_KERNEL).listTriggers()).toHaveLength(1);

    await created.close();
  });

  it('drops an event that arrives without its envelope', async () => {
    const { bus, subscribed } = subscriptionBus();
    const created = await bootWith(['promo.bonus.granted'], [recording], bus);

    for (const handler of subscribed.get('promo.bonus.granted') ?? []) {
      await handler({ userId: 'user-1' });
    }

    expect(heardTriggers()).toEqual([]);

    await created.close();
  });

  it('still delivers to the other listeners when one throws', async () => {
    const { bus, logger, deliver } = brokerBackedBus();
    const created = await bootWith(['identity.user.login'], [throwing, recording], bus);
    const envelope = loginEnvelope();

    await expect(deliver(envelope)).resolves.toBeUndefined();

    expect(heardTriggers()).toEqual([
      expect.objectContaining({ envelope: expect.objectContaining({ eventId: envelope.eventId }) }),
    ]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'identity.user.login' }),
      'event subscriber threw',
    );

    await created.close();
  });
});

describe('createApp - streaming responses opt out of transformation', () => {
  it('marks an SSE response no-transform so an intermediary cannot batch its frames', async () => {
    const saved = process.env['REDIS_URL'];
    process.env['REDIS_URL'] = redisUrlForWorker();
    try {
      const created = await createApp({ plugins: [], databaseUrl: DUMMY_DATABASE_URL });
      created.app.get('/sse-probe', (c) =>
        c.body(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } }),
      );

      const stream = await created.app.request('/sse-probe');
      expect(stream.headers.get('cache-control')).toBe('no-store, no-transform');
      expect(stream.headers.get('x-accel-buffering')).toBe('no');

      const json = await created.app.request('/health');
      expect(json.headers.get('cache-control')).toBe('no-store');
      expect(json.headers.get('x-accel-buffering')).toBeNull();

      await created.close();
    } finally {
      if (saved === undefined) {
        delete process.env['REDIS_URL'];
      } else {
        process.env['REDIS_URL'] = saved;
      }
    }
  });
});

describe('createApp - httpCache.additionalPaths', () => {
  it('keeps the built-in cache paths cacheable while adding a consumer path', async () => {
    const saved = process.env['REDIS_URL'];
    process.env['REDIS_URL'] = redisUrlForWorker();
    try {
      const created = await createApp({
        plugins: [],
        databaseUrl: DUMMY_DATABASE_URL,
        httpCache: { additionalPaths: ['/email-assets'] },
      });
      created.app.get('/cms/pages', (c) => c.json({ ok: true }));
      created.app.get('/lobby/layout', (c) => c.json({ ok: true }));
      created.app.get('/email-assets/banner.png', (c) => c.body('png'));
      created.app.get('/wallet/balance', (c) => c.json({ ok: true }));

      const builtIn = await created.app.request('/cms/pages');
      expect(builtIn.headers.get('cache-control')).toMatch(/^public,/);

      const layout = await created.app.request('/lobby/layout');
      expect(layout.headers.get('cache-control')).toBe('no-store');

      const added = await created.app.request('/email-assets/banner.png');
      expect(added.headers.get('cache-control')).toMatch(/^public,/);

      const uncacheable = await created.app.request('/wallet/balance');
      expect(uncacheable.headers.get('cache-control')).toBe('no-store');

      await created.close();
    } finally {
      if (saved === undefined) {
        delete process.env['REDIS_URL'];
      } else {
        process.env['REDIS_URL'] = saved;
      }
    }
  });

  it('lets `paths` still replace the default list wholesale, ignoring additionalPaths', async () => {
    const saved = process.env['REDIS_URL'];
    process.env['REDIS_URL'] = redisUrlForWorker();
    try {
      const created = await createApp({
        plugins: [],
        databaseUrl: DUMMY_DATABASE_URL,
        httpCache: { paths: ['/only-this'], additionalPaths: ['/ignored-since-paths-is-set'] },
      });
      created.app.get('/cms/pages', (c) => c.json({ ok: true }));
      created.app.get('/ignored-since-paths-is-set', (c) => c.json({ ok: true }));

      const builtIn = await created.app.request('/cms/pages');
      expect(builtIn.headers.get('cache-control')).toBe('no-store');

      const ignored = await created.app.request('/ignored-since-paths-is-set');
      expect(ignored.headers.get('cache-control')).toBe('no-store');

      await created.close();
    } finally {
      if (saved === undefined) {
        delete process.env['REDIS_URL'];
      } else {
        process.env['REDIS_URL'] = saved;
      }
    }
  });
});

describe('createApp - service name for the Redis Streams consumer group', () => {
  const saved = { redis: process.env['REDIS_URL'], manifest: process.env['SERVICE_MANIFEST'] };

  afterEach(() => {
    // Restore rather than delete: a bare delete would strip a REDIS_URL the rest of
    // the suite (or a CI service container) legitimately set.
    for (const [key, value] of [
      ['REDIS_URL', saved.redis],
      ['SERVICE_MANIFEST', saved.manifest],
    ] as const) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('refuses to boot a split service that has no SERVICE_NAME of its own', async () => {
    // The consumer group is a durable identity, so it can never be derived from
    // SERVICE_MANIFEST - that is a list of module ids ('wallet,iam') which reorders
    // and grows. Throws before any Redis client is opened.
    process.env['REDIS_URL'] = 'redis://127.0.0.1:1';
    process.env['SERVICE_MANIFEST'] = 'wallet,iam';
    delete process.env['SERVICE_NAME'];

    await expect(createApp({ plugins: [], databaseUrl: DUMMY_DATABASE_URL })).rejects.toThrow(
      /SERVICE_MANIFEST is set but SERVICE_NAME is not/,
    );
  });
});

describe('createApp - SERVICE_MANIFEST and JOB_WORKERS on the plugin list it is given', () => {
  const keys = ['REDIS_URL', 'SERVICE_MANIFEST', 'SERVICE_NAME', 'JOB_WORKERS'] as const;
  const saved = keys.map((key) => [key, process.env[key]] as const);

  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  // A static list, as a consumer that never calls loadExtensions() passes it.
  const plugins: PluginEntry[] = [
    { id: 'fixture-base', path: fixture('base') },
    { id: 'fixture-feature', path: fixture('feature') },
    { id: 'fixture-leaf', path: fixture('leaf') },
  ];

  /** Boots the fixtures under `env` and returns the queues whose workers were registered. */
  async function bootQueues(
    env: { SERVICE_MANIFEST?: string; JOB_WORKERS?: string },
    list: PluginEntry[] = plugins,
  ) {
    process.env['REDIS_URL'] = redisUrlForWorker();
    for (const key of ['SERVICE_MANIFEST', 'SERVICE_NAME', 'JOB_WORKERS'] as const) {
      delete process.env[key];
    }
    if (env.SERVICE_MANIFEST) {
      process.env['SERVICE_MANIFEST'] = env.SERVICE_MANIFEST;
      process.env['SERVICE_NAME'] = 'fixture';
    }
    if (env.JOB_WORKERS) {
      process.env['JOB_WORKERS'] = env.JOB_WORKERS;
    }
    const jobs = makeJobQueue();
    const created = await createApp({ plugins: list, databaseUrl: DUMMY_DATABASE_URL }, (c) => {
      c.register(JOB_QUEUE, () => jobs);
    });
    await created.close();
    return vi.mocked(jobs.registerWorker).mock.calls.map(([registration]) => registration.queue);
  }

  it('boots only the modules the manifest selects', async () => {
    expect(await bootQueues({ SERVICE_MANIFEST: 'fixture-base' })).toEqual([
      'fixture-base.daily',
      'fixture-base.weekly',
    ]);
  });

  it('names every module the manifest leaves out in one boot error', async () => {
    await expect(bootQueues({ SERVICE_MANIFEST: 'fixture-leaf' })).rejects.toThrow(
      /fixture-feature \(required by fixture-leaf\)[\s\S]*fixture-base \(required by fixture-feature\)[\s\S]*SERVICE_MANIFEST=fixture-leaf,fixture-feature,fixture-base/,
    );
  });

  it('registers only the workers JOB_WORKERS selects', async () => {
    expect(await bootQueues({ JOB_WORKERS: 'fixture-base.*,!fixture-base.weekly' })).toEqual([
      'fixture-base.daily',
    ]);
    expect(await bootQueues({ JOB_WORKERS: '!fixture-base.*' })).toEqual(['fixture-feature.sync']);
  });

  it('boots with an exclusion that matches no queue', async () => {
    expect(await bootQueues({ JOB_WORKERS: '!absent.*' })).toHaveLength(3);
  });

  it('fails the boot on an inclusion that matches no queue', async () => {
    await expect(bootQueues({ JOB_WORKERS: 'fixture-bsae.*' })).rejects.toThrow(
      /does not register: fixture-bsae\.\*/,
    );
  });

  it('fails the boot on a malformed JOB_WORKERS', async () => {
    await expect(bootQueues({ JOB_WORKERS: 'none,fixture-base.daily' })).rejects.toThrow(
      /"none" stands alone/,
    );
  });

  it('starts a worker a router factory registers', async () => {
    const late = [{ id: 'fixture-late-worker', path: fixture('late-worker') }];

    expect(await bootQueues({}, late)).toEqual(['fixture-late-worker.run']);
    expect(await bootQueues({ JOB_WORKERS: 'fixture-late-worker.*' }, late)).toEqual([
      'fixture-late-worker.run',
    ]);
  });
});

describe('createApp - a split service fails closed on a control it would skip', () => {
  const keys = ['REDIS_URL', 'SERVICE_MANIFEST', 'SERVICE_NAME'] as const;
  const saved = keys.map((key) => [key, process.env[key]] as const);

  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  const entry = (id: string, name: string): PluginEntry => ({ id, path: fixture(name) });
  const limited = entry('fixture-limited', 'limited');
  const limits = entry('fixture-limits', 'limits');
  const admin = entry('fixture-admin', 'admin');
  const iam = entry('iam', 'iam');
  const identity = entry('identity', 'identity');
  const base = entry('fixture-base', 'base');

  /** Boots `plugins` under `manifest` (none: a full boot) and closes the app again. */
  async function boot(
    plugins: PluginEntry[],
    manifest?: string,
    configure?: (container: Container<CoreTokenCatalog>) => void,
  ) {
    process.env['REDIS_URL'] = redisUrlForWorker();
    delete process.env['SERVICE_MANIFEST'];
    delete process.env['SERVICE_NAME'];
    if (manifest) {
      process.env['SERVICE_MANIFEST'] = manifest;
      process.env['SERVICE_NAME'] = 'fixture';
    }
    const created = await createApp({ plugins, databaseUrl: DUMMY_DATABASE_URL }, (c) => {
      c.register(JOB_QUEUE, () => makeJobQueue());
      configure?.(c);
    });
    await created.close();
  }

  it("refuses a module's unbound control port, naming the module that binds it", async () => {
    await expect(boot([limited, limits], 'fixture-limited')).rejects.toThrow(
      /- fixture-limited runs without FIXTURE_LIMITS \(bound by fixture-limits\): fixture limits go unenforced\nAdd them: SERVICE_MANIFEST=fixture-limited,fixture-limits/,
    );
  });

  it('registers each loaded plugin once and closes the connection it opened when it refuses', async () => {
    const counted = entry('fixture-counted', 'counted');
    const openSockets = () =>
      process.getActiveResourcesInfo().filter((type) => type === 'TCPSocketWrap').length;
    const socketsBefore = openSockets();
    countedRegistrations().count = 0;

    await expect(boot([counted, limits], 'fixture-counted')).rejects.toThrow(
      /- fixture-counted runs without FIXTURE_LIMITS \(bound by fixture-limits\)/,
    );

    expect(countedRegistrations().count).toBe(1);
    await vi.waitFor(() => expect(openSockets()).toBeLessThanOrEqual(socketsBefore), {
      timeout: 2_000,
    });
  });

  it('boots once the manifest has that module, or the composition root binds the port', async () => {
    await expect(
      boot([limited, limits], 'fixture-limited,fixture-limits'),
    ).resolves.toBeUndefined();
    await expect(
      boot([limited, limits], 'fixture-limited', (c) =>
        c.registerUnsafe(FIXTURE_LIMITS, () => ({ check: () => true })),
      ),
    ).resolves.toBeUndefined();
  });

  it('refuses admin routes without the ports AdminGuard checks them with', async () => {
    await expect(boot([admin, iam, identity], 'fixture-admin')).rejects.toThrow(
      /- AdminGuard runs without ADMIN_PERMISSION_RESOLVER \(bound by iam\)[\s\S]*- AdminGuard runs without ADMIN_SECURITY_POLICY \(bound by identity\)[\s\S]*Add them: SERVICE_MANIFEST=fixture-admin,iam,identity/,
    );
  });

  it('boots admin routes once the manifest has iam and identity', async () => {
    await expect(
      boot([admin, iam, identity], 'fixture-admin,iam,identity'),
    ).resolves.toBeUndefined();
  });

  it('refuses a split that serves no admin routes without them too', async () => {
    await expect(boot([base, iam, identity], 'fixture-base')).rejects.toThrow(
      /- AdminGuard runs without ADMIN_PERMISSION_RESOLVER \(bound by iam\)[\s\S]*Add them: SERVICE_MANIFEST=fixture-base,iam,identity/,
    );
  });

  it('builds AdminGuard at boot under a manifest, so a guard that cannot be built fails the boot', async () => {
    const broken = (c: Container<CoreTokenCatalog>) =>
      c.register(ADMIN_GUARD, () => {
        throw new Error('fixture guard cannot be built');
      });

    await expect(boot([base], 'fixture-base', broken)).rejects.toThrow(
      'fixture guard cannot be built',
    );
    await expect(boot([base], undefined, broken)).resolves.toBeUndefined();
  });

  it('names a missing dependency, required port, control and guard port in one error whose manifest boots', async () => {
    const plugins = [
      entry('fixture-split', 'split'),
      entry('fixture-feature', 'feature'),
      base,
      entry('fixture-leaf', 'leaf'),
      entry('fixture-dispatch', 'dispatch'),
      limits,
      iam,
      identity,
    ];

    const refused = await boot(plugins, 'fixture-split').then(
      () => new Error('booted'),
      (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
    );

    expect(refused.message).toContain(
      'SERVICE_MANIFEST=fixture-split leaves out what this service needs:\n' +
        '  - fixture-feature (required by fixture-split, fixture-leaf)\n' +
        '  - fixture-base (required by fixture-feature)\n' +
        '  - fixture-split requires FIXTURE_DISPATCH (bound by fixture-dispatch)\n' +
        '  - fixture-split runs without FIXTURE_LIMITS (bound by fixture-limits): fixture limits go unenforced\n',
    );
    expect(refused.message).toMatch(/- AdminGuard runs without ADMIN_PERMISSION_RESOLVER/);
    expect(refused.message).toMatch(/- fixture-leaf \(required by fixture-dispatch\)/);
    const suggested = /^Add them: SERVICE_MANIFEST=(\S+)$/m.exec(refused.message)?.[1];
    expect(suggested).toBe(
      'fixture-split,fixture-feature,fixture-base,fixture-dispatch,fixture-limits,iam,identity,fixture-leaf',
    );
    await expect(boot(plugins, suggested)).resolves.toBeUndefined();
  });

  it('boots a full install unchanged, the controls left unbound', async () => {
    await expect(boot([limited, admin])).resolves.toBeUndefined();
  });

  it('boots a manifest whose plugin list has no module behind the controls', async () => {
    await expect(boot([limited, admin], 'fixture-limited,fixture-admin')).resolves.toBeUndefined();
  });
});

describe('createApp - the player-activity stamp', () => {
  it('lands before the request that refreshed it returns', async () => {
    const saved = process.env['REDIS_URL'];
    process.env['REDIS_URL'] = redisUrlForWorker();
    try {
      let release: (() => void) | undefined;
      const writing = new Promise<void>((resolve) => {
        release = resolve;
      });
      let stamped = false;

      const created = await createApp(
        { plugins: [], databaseUrl: DUMMY_DATABASE_URL },
        (container) => {
          // A session the resolver can answer without a database, so the request reaches
          // the activity stamp at all.
          container.register(AUTH_SESSION, () =>
            mock<SessionResolver>({
              resolveUserId: async () => 'user-1',
              resolveSession: async () => ({ userId: 'user-1' }),
            }),
          );
          container.register(PLAYER_ACTIVITY_TRACKER, () => ({
            touchLastSeen: async () => {
              await writing;
              stamped = true;
            },
            countActiveSince: async () => 0,
          }));
        },
      );
      // Read at handler time: a fire-and-forget stamp leaves this false, which is the
      // read-after-write race every presence-gated feature would inherit.
      created.app.get('/activity-probe', (c) => c.json({ stamped }));

      // `request()` is typed as Response | Promise<Response>; normalise so the
      // pending-ness below is observable.
      const response = Promise.resolve(created.app.request('/activity-probe'));
      let settled = false;
      void response.then(() => {
        settled = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);

      release?.();
      expect(await (await response).json()).toEqual({ stamped: true });

      await created.close();
    } finally {
      if (saved === undefined) {
        delete process.env['REDIS_URL'];
      } else {
        process.env['REDIS_URL'] = saved;
      }
    }
  });
});

describe('createApp - client address at the ingress', () => {
  // What `@hono/node-server` hands the app: the socket the request arrived on.
  const fromPeer = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress } } });

  it('keys a direct caller on its socket, however it rotates X-Real-IP', async () => {
    const saved = process.env['REDIS_URL'];
    process.env['REDIS_URL'] = redisUrlForWorker();
    try {
      const created = await createApp({ plugins: [], databaseUrl: DUMMY_DATABASE_URL });
      created.app.get('/ip-probe', (c) => c.json({ ip: getCurrentClientMeta().ip }));

      const seen = [];
      for (const spoofed of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) {
        const res = await created.app.request(
          '/ip-probe',
          { headers: { 'x-real-ip': spoofed, 'x-forwarded-for': spoofed } },
          fromPeer('203.0.113.7'),
        );
        seen.push((await res.json()).ip);
      }
      expect(seen).toEqual(['203.0.113.7', '203.0.113.7', '203.0.113.7']);

      await created.close();
    } finally {
      if (saved === undefined) {
        delete process.env['REDIS_URL'];
      } else {
        process.env['REDIS_URL'] = saved;
      }
    }
  });

  it('takes X-Real-IP from a configured trusted proxy only', async () => {
    const saved = process.env['REDIS_URL'];
    process.env['REDIS_URL'] = redisUrlForWorker();
    try {
      const created = await createApp({
        plugins: [],
        databaseUrl: DUMMY_DATABASE_URL,
        trustedProxies: ['192.0.2.10'],
      });
      created.app.get('/ip-probe', (c) => c.json({ ip: getCurrentClientMeta().ip }));
      const probe = async (peer: string) =>
        (
          await (
            await created.app.request(
              '/ip-probe',
              { headers: { 'x-real-ip': '198.51.100.1' } },
              fromPeer(peer),
            )
          ).json()
        ).ip;

      expect(await probe('192.0.2.10')).toBe('198.51.100.1');
      // Private, but not in the configured list - the default ranges no longer apply.
      expect(await probe('10.0.0.5')).toBe('10.0.0.5');

      await created.close();
    } finally {
      if (saved === undefined) {
        delete process.env['REDIS_URL'];
      } else {
        process.env['REDIS_URL'] = saved;
      }
    }
  });

  it('gives each client its own address behind an XFF-only trusted proxy', async () => {
    const saved = process.env['REDIS_URL'];
    process.env['REDIS_URL'] = redisUrlForWorker();
    try {
      const created = await createApp({
        plugins: [],
        databaseUrl: DUMMY_DATABASE_URL,
        trustedProxies: ['10.0.0.0/8'],
      });
      created.app.get('/ip-probe', (c) => c.json({ ip: getCurrentClientMeta().ip }));

      const seen = [];
      for (const client of ['198.51.100.1', '198.51.100.2']) {
        const res = await created.app.request(
          '/ip-probe',
          { headers: { 'x-forwarded-for': client } },
          fromPeer('10.0.0.2'),
        );
        seen.push((await res.json()).ip);
      }
      // Not null: a null IP would put every login behind this proxy in one `unknown` bucket.
      expect(seen).toEqual(['198.51.100.1', '198.51.100.2']);

      await created.close();
    } finally {
      if (saved === undefined) {
        delete process.env['REDIS_URL'];
      } else {
        process.env['REDIS_URL'] = saved;
      }
    }
  });

  it('refuses to boot on a malformed trusted proxy entry', async () => {
    await expect(
      createApp({ plugins: [], databaseUrl: DUMMY_DATABASE_URL, trustedProxies: ['10.0.0.1/'] }),
    ).rejects.toThrow(/Invalid trusted proxy entry/);
  });
});

describe('createApp - request hardening', () => {
  const ALLOWED_ORIGIN = 'https://app.example.test';
  const FOREIGN_ORIGIN = 'https://evil.example.test';
  const savedEnv = { redis: process.env['REDIS_URL'], cors: process.env['CORS_ORIGINS'] };

  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  };

  afterEach(() => {
    restore('REDIS_URL', savedEnv.redis);
    restore('CORS_ORIGINS', savedEnv.cors);
  });

  const bootWith = async (config: Partial<Parameters<typeof createApp>[0]> = {}) => {
    process.env['REDIS_URL'] = redisUrlForWorker();
    const created = await createApp({ plugins: [], databaseUrl: DUMMY_DATABASE_URL, ...config });
    created.app.post('/echo-size', async (c) =>
      c.json({ bytes: (await c.req.arrayBuffer()).byteLength }),
    );
    return created;
  };

  it('refuses to boot without CORS origins instead of reflecting every origin', async () => {
    delete process.env['CORS_ORIGINS'];
    await expect(bootWith()).rejects.toThrow(/CORS_ORIGINS/);
  });

  it("refuses to boot on a leftover '*' instead of CORS-blocking every browser", async () => {
    process.env['CORS_ORIGINS'] = '*';
    await expect(bootWith()).rejects.toThrow(/not a CORS origin/);
    await expect(bootWith({ cors: { origins: ['*'] } })).rejects.toThrow(/not a CORS origin/);
  });

  it('reads CORS origins from CORS_ORIGINS and allows only those', async () => {
    process.env['CORS_ORIGINS'] = ` ${ALLOWED_ORIGIN} ,https://admin.example.test`;
    const created = await bootWith();

    const allowed = await created.app.request('/health', { headers: { origin: ALLOWED_ORIGIN } });
    expect(allowed.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(allowed.headers.get('access-control-allow-credentials')).toBe('true');

    const foreign = await created.app.request('/health', { headers: { origin: FOREIGN_ORIGIN } });
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull();

    await created.close();
  });

  it('sends no CORS headers when cors is false', async () => {
    delete process.env['CORS_ORIGINS'];
    const created = await bootWith({ cors: false });

    const res = await created.app.request('/health', { headers: { origin: ALLOWED_ORIGIN } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();

    await created.close();
  });

  it('rejects a body over the limit with 413 the browser can read, and serves one under it', async () => {
    process.env['CORS_ORIGINS'] = ALLOWED_ORIGIN;
    const created = await bootWith({ bodyLimit: { maxBytes: 1024 } });

    const under = await created.app.request('/echo-size', {
      method: 'POST',
      body: 'x'.repeat(1024),
    });
    expect(under.status).toBe(200);
    expect(await under.json()).toEqual({ bytes: 1024 });

    const over = await created.app.request('/echo-size', {
      method: 'POST',
      body: 'x'.repeat(1025),
      headers: { origin: ALLOWED_ORIGIN },
    });
    expect(over.status).toBe(413);
    expect(over.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);

    await created.close();
  });

  it.each([Number.NaN, 0, -1, 1.5, Number.POSITIVE_INFINITY])(
    'refuses to boot with a malformed bodyLimit.maxBytes (%s)',
    async (maxBytes) => {
      process.env['CORS_ORIGINS'] = ALLOWED_ORIGIN;
      await expect(bootWith({ bodyLimit: { maxBytes } })).rejects.toThrow(/bodyLimit\.maxBytes/);
    },
  );

  it('rejects a chunked body that streams past the limit', async () => {
    const created = await bootWith({ bodyLimit: { maxBytes: 1024 } });
    const chunk = new TextEncoder().encode('x'.repeat(600));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
    });

    const res = await created.app.request('/echo-size', {
      method: 'POST',
      body,
      duplex: 'half',
    } as RequestInit);
    expect(res.status).toBe(413);

    await created.close();
  });

  it('applies a 4 MiB limit by default', async () => {
    const created = await bootWith();
    const fourMiB = 4 * 1024 * 1024;

    const atLimit = await created.app.request('/echo-size', {
      method: 'POST',
      body: 'x'.repeat(fourMiB),
    });
    expect(atLimit.status).toBe(200);

    const overLimit = await created.app.request('/echo-size', {
      method: 'POST',
      body: 'x'.repeat(fourMiB + 1),
    });
    expect(overLimit.status).toBe(413);

    await created.close();
  });
});

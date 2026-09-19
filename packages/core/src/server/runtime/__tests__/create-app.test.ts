import { describe, it, expect, afterEach } from 'vitest';
import {
  MESSAGE_BROKER,
  JOB_QUEUE,
  CACHE,
  RATE_LIMITER,
  PLAYER_ACTIVITY_TRACKER,
} from '@openora/core/contracts';
import { redisUrlForWorker } from '@openora/core/testing';
import { mock } from '../../../testing/mock.js';
import { AUTH_SESSION, type SessionResolver } from '../../auth/index.js';
import { createApp } from '../create-app.js';
import { getCurrentClientMeta } from '../../kernel/request-context.js';

// A syntactically valid but unreachable DB url - fine here because nothing in this
// suite ever runs a query: DrizzleService's pg.Pool connects lazily, and neither
// health.ping nor better-auth's getSession() touch the DB when the request carries
// no session cookie (getSessionFromCtx short-circuits on a missing cookie).
const DUMMY_DATABASE_URL = 'postgres://test:test@127.0.0.1:1/create_app_test';

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
      const created = await createApp({ plugins: [], databaseUrl: DUMMY_DATABASE_URL });
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

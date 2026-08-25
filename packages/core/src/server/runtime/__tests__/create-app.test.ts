import { describe, it, expect, afterEach } from 'vitest';
import { MESSAGE_BROKER, JOB_QUEUE, CACHE, RATE_LIMITER } from '@openora/core/contracts';
import { redisUrlForWorker } from '@openora/core/testing';
import { createApp } from '../create-app.js';

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

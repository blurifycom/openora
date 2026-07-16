import { describe, it, expect } from 'vitest';
import { MESSAGE_BROKER, JOB_QUEUE, CACHE, RATE_LIMITER } from '@openora/core/contracts';
import {
  InMemoryBroker,
  InProcessJobQueue,
  InProcessCache,
  InProcessRateLimiter,
} from '@openora/core/testing';
import { createLogger } from '../../kernel/index.js';
import { createApp } from '../create-app.js';

// A syntactically valid but unreachable DB url - fine here because nothing in this
// suite ever runs a query: DrizzleService's pg.Pool connects lazily, and neither
// health.ping nor better-auth's getSession() touch the DB when the request carries
// no session cookie (getSessionFromCtx short-circuits on a missing cookie).
const DUMMY_DATABASE_URL = 'postgres://test:test@127.0.0.1:1/create_app_test';

describe('createApp - distributed-only durable seams (ADR-0030)', () => {
  it('throws a clear, actionable error when no durable seam is bound', async () => {
    await expect(
      createApp({ plugins: [], databaseUrl: DUMMY_DATABASE_URL, openapi: { enabled: false } }),
    ).rejects.toThrow(/MESSAGE_BROKER.*JOB_QUEUE.*CACHE.*RATE_LIMITER/s);
  });

  it('boots and serves once the fakes are bound via configure', async () => {
    const created = await createApp({
      plugins: [],
      databaseUrl: DUMMY_DATABASE_URL,
      openapi: { enabled: false },
      configure(container) {
        container.register(MESSAGE_BROKER, () => new InMemoryBroker());
        container.register(JOB_QUEUE, () => new InProcessJobQueue(createLogger('job-queue')));
        container.register(CACHE, () => new InProcessCache());
        container.register(RATE_LIMITER, () => new InProcessRateLimiter());
      },
    });

    const res = await created.app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok' });

    await created.close();
  });
});

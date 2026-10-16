import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeAll, afterEach, afterAll } from 'vitest';
import { Queue } from 'bullmq';
import { JOB_QUEUE, queue } from '@openora/core/contracts';
import { createTestRedis, redisUrlForWorker, type TestRedis } from '@openora/core/testing';
import { createApp, type CreatedApp } from '../create-app.js';

// Nothing here runs a query; the pool connects lazily.
const DUMMY_DATABASE_URL = 'postgres://test:test@127.0.0.1:1/create_app_test';
const POLL = { timeout: 5000, interval: 20 };

let redis: TestRedis;
let app: CreatedApp | null = null;
const rawQueues: Queue[] = [];
const saved = { redis: process.env['REDIS_URL'], workers: process.env['JOB_WORKERS'] };

function rawQueue(name: string): Queue {
  const q = new Queue(name, {
    connection: { url: redisUrlForWorker(), maxRetriesPerRequest: null },
  });
  rawQueues.push(q);
  return q;
}

beforeAll(async () => {
  redis = await createTestRedis();
});

afterEach(async () => {
  await app?.close();
  app = null;
  await Promise.allSettled(rawQueues.map((q) => q.close()));
  rawQueues.length = 0;
  await redis.flush();
  for (const [key, value] of [
    ['REDIS_URL', saved.redis],
    ['JOB_WORKERS', saved.workers],
  ] as const) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

afterAll(async () => {
  await redis.quit();
});

describe('createApp - JOB_WORKERS on the real queue driver', () => {
  it('consumes the selected queue and leaves the other one waiting for another process', async () => {
    process.env['REDIS_URL'] = redisUrlForWorker();
    process.env['JOB_WORKERS'] = 'fixture-base.daily';
    const path = fileURLToPath(new URL('./fixtures/base-plugin.ts', import.meta.url));
    app = await createApp({
      plugins: [{ id: 'fixture-base', path }],
      databaseUrl: DUMMY_DATABASE_URL,
    });
    const jobs = app.container.get(JOB_QUEUE);

    await jobs.enqueue(queue('fixture-base.weekly'), {});
    await jobs.enqueue(queue('fixture-base.daily'), {});

    const daily = rawQueue('fixture-base.daily');
    const weekly = rawQueue('fixture-base.weekly');
    await vi.waitFor(
      async () => expect(await daily.getJobCounts()).toMatchObject({ completed: 1 }),
      POLL,
    );
    // The daily job ran, so this process's workers are live; give the weekly queue the same chance.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await weekly.getJobCounts()).toMatchObject({ waiting: 1, completed: 0, active: 0 });
  });
});

import { describe, it, expect, vi, beforeAll, afterEach, afterAll } from 'vitest';
import { Queue } from 'bullmq';
import { z } from 'zod';
import { queue } from '@openora/core/contracts';
import { createTestRedis, redisUrlForWorker, type TestRedis } from '@openora/core/testing';
import { BullMqJobQueue } from '../bullmq-job-queue.js';

const Payload = z.object({ value: z.string() });
const POLL = { timeout: 5000, interval: 20 };

let redis: TestRedis;
const instances: BullMqJobQueue[] = [];
const rawQueues: Queue[] = [];

function makeQueue(): BullMqJobQueue {
  const q = new BullMqJobQueue(redisUrlForWorker());
  instances.push(q);
  return q;
}

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
  await Promise.allSettled(instances.map((q) => q.close()));
  await Promise.allSettled(rawQueues.map((q) => q.close()));
  instances.length = 0;
  rawQueues.length = 0;
  await redis.flush();
});

afterAll(async () => {
  await redis.quit();
});

describe('BullMqJobQueue', () => {
  it('enqueues, validates the payload, and hands the worker a JobContext', async () => {
    const q = makeQueue();
    const seen: Array<Record<string, unknown>> = [];
    q.registerWorker({
      queue: queue('demo'),
      schema: Payload,
      handler: (ctx) => {
        seen.push({ ...ctx });
      },
    });

    const result = await q.enqueue(
      queue('demo'),
      { value: 'hi' },
      { idempotencyKey: 'k1', meta: { correlationId: 'c1' } },
    );
    expect(result.id).toBe('k1');

    await vi.waitFor(() => expect(seen).toHaveLength(1), POLL);
    const ctx = seen[0]!;
    expect(ctx['id']).toBe('k1');
    expect(ctx['name']).toBe('demo');
    expect(ctx['payload']).toEqual({ value: 'hi' });
    expect(ctx['attempt']).toBe(1);
    expect(ctx['meta']).toEqual({ correlationId: 'c1', idempotencyKey: 'k1' });
    expect(ctx['enqueuedAt']).toBeInstanceOf(Date);
  });

  it('dedupes concurrent enqueues that share an idempotencyKey', async () => {
    const q = makeQueue();
    let count = 0;
    q.registerWorker({
      queue: queue('dedupe'),
      schema: Payload,
      handler: () => {
        count += 1;
      },
    });

    await q.enqueue(queue('dedupe'), { value: 'a' }, { idempotencyKey: 'k1' });
    await q.enqueue(queue('dedupe'), { value: 'b' }, { idempotencyKey: 'k1' });

    await vi.waitFor(() => expect(count).toBe(1), POLL);
    await new Promise((r) => setTimeout(r, 150));
    expect(count).toBe(1);
  });

  it('delays processing by delayMs', async () => {
    const q = makeQueue();
    const enqueuedAt = Date.now();
    let processedAt = 0;
    q.registerWorker({
      queue: queue('delayed'),
      schema: Payload,
      handler: () => {
        processedAt = Date.now();
      },
    });

    await q.enqueue(queue('delayed'), { value: 'hi' }, { delayMs: 300 });

    await vi.waitFor(() => expect(processedAt).toBeGreaterThan(0), POLL);
    expect(processedAt - enqueuedAt).toBeGreaterThanOrEqual(250);
  });

  it('retries a failing handler up to attempts with backoff, then dead-letters', async () => {
    const q = makeQueue();
    const attempts: number[] = [];
    const deadLettered: Array<{ attempt: number; error: string }> = [];
    q.registerWorker({
      queue: queue('retry'),
      schema: Payload,
      handler: (ctx) => {
        attempts.push(ctx.attempt);
        throw new Error('always fails');
      },
      onDeadLetter: (ctx, error) => {
        deadLettered.push({ attempt: ctx.attempt, error: error.message });
      },
    });

    await q.enqueue(
      queue('retry'),
      { value: 'hi' },
      { attempts: 2, backoff: { type: 'fixed', delayMs: 30 } },
    );

    await vi.waitFor(() => expect(attempts).toEqual([1, 2]), POLL);
    await vi.waitFor(() => expect(deadLettered).toHaveLength(1), POLL);
    expect(deadLettered[0]).toEqual({ attempt: 2, error: 'always fails' });
  });

  it('dead-letters only once retries are exhausted and swallows a throwing hook', async () => {
    const q = makeQueue();
    let deadLetterCalls = 0;
    q.registerWorker({
      queue: queue('poison'),
      schema: Payload,
      handler: () => {
        throw new Error('boom');
      },
      onDeadLetter: async () => {
        deadLetterCalls += 1;
        throw new Error('hook boom');
      },
    });

    await q.enqueue(
      queue('poison'),
      { value: 'hi' },
      { attempts: 2, backoff: { type: 'fixed', delayMs: 30 } },
    );

    await vi.waitFor(() => expect(deadLetterCalls).toBe(1), POLL);
    // The hook threw, but the queue kept running (no unhandled rejection) - still one call.
    await new Promise((r) => setTimeout(r, 120));
    expect(deadLetterCalls).toBe(1);
  });

  it('fails the job when the payload does not match the schema', async () => {
    const q = makeQueue();
    let handlerCalls = 0;
    const deadLettered: unknown[] = [];
    q.registerWorker({
      queue: queue('validate'),
      schema: Payload,
      handler: () => {
        handlerCalls += 1;
      },
      onDeadLetter: (ctx) => {
        deadLettered.push(ctx.payload);
      },
    });

    await q.enqueue(queue('validate'), { value: 42 } as never);

    await vi.waitFor(() => expect(deadLettered).toHaveLength(1), POLL);
    expect(handlerCalls).toBe(0);
    expect(deadLettered[0]).toEqual({ value: 42 });
  });

  it('registers a cron job scheduler and removes it on unschedule', async () => {
    const q = makeQueue();
    await q.schedule(
      queue('sched'),
      'daily',
      { value: 'x' },
      { cron: '0 0 * * *', timezone: 'UTC' },
    );

    const raw = rawQueue('sched');
    const scheduled = await raw.getJobSchedulers();
    const daily = scheduled.find((s) => s.key === 'daily');
    expect(daily?.pattern).toBe('0 0 * * *');
    expect(daily?.tz).toBe('UTC');

    await q.unschedule(queue('sched'), 'daily');
    expect(await raw.getJobSchedulers()).toHaveLength(0);
  });

  it('registers an everyMs job scheduler', async () => {
    const q = makeQueue();
    await q.schedule(queue('tick'), 'interval', { value: 'x' }, { everyMs: 60000 });

    const raw = rawQueue('tick');
    const interval = (await raw.getJobSchedulers()).find((s) => s.key === 'interval');
    expect(interval?.every).toBe(60000);
  });

  it('close drains an in-flight job before resolving', async () => {
    const q = makeQueue();
    let started = false;
    let finished = false;
    q.registerWorker({
      queue: queue('drain'),
      schema: Payload,
      handler: async () => {
        started = true;
        await new Promise((r) => setTimeout(r, 100));
        finished = true;
      },
    });

    await q.enqueue(queue('drain'), { value: 'hi' });
    await vi.waitFor(() => expect(started).toBe(true), POLL);

    await q.close();
    expect(finished).toBe(true);
  });
});

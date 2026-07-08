import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { queue } from '@blurifycom/core/contracts';

type FakeJob = {
  id?: string;
  name: string;
  data: { payload: unknown; meta: Record<string, string | undefined> };
  attemptsMade: number;
  timestamp: number;
  opts: { attempts?: number };
};
type FakeProcessor = (job: FakeJob) => Promise<void>;
type FailedHandler = (job: FakeJob | undefined, error: Error) => void;

const { queues, workers, closeOrder, FakeQueue, FakeWorker } = vi.hoisted(() => {
  const closeOrder: string[] = [];

  class FakeQueue {
    readonly add = vi.fn(async () => ({ id: 'job-1' }));
    readonly upsertJobScheduler = vi.fn(async () => ({}));
    readonly removeJobScheduler = vi.fn(async () => true);
    readonly close = vi.fn(async () => {
      closeOrder.push('queue');
    });
    constructor(
      readonly name: string,
      readonly opts: unknown,
    ) {
      queues.push(this);
    }
  }

  class FakeWorker {
    readonly handlers = new Map<string, FailedHandler>();
    readonly close = vi.fn(async () => {
      closeOrder.push('worker');
    });
    constructor(
      readonly name: string,
      readonly processor: FakeProcessor,
      readonly opts: { concurrency?: number },
    ) {
      workers.push(this);
    }
    on(event: string, cb: FailedHandler): this {
      this.handlers.set(event, cb);
      return this;
    }
  }

  const queues: FakeQueue[] = [];
  const workers: FakeWorker[] = [];
  return { queues, workers, closeOrder, FakeQueue, FakeWorker };
});

vi.mock('bullmq', () => ({ Queue: FakeQueue, Worker: FakeWorker }));

const { BullMqJobQueue } = await import('../bullmq-job-queue.js');

const Payload = z.object({ value: z.string() });
const flush = () => new Promise((r) => setTimeout(r, 0));
const REDIS_URL = 'redis://localhost:6379';

beforeEach(() => {
  queues.length = 0;
  workers.length = 0;
  closeOrder.length = 0;
});

describe('BullMqJobQueue', () => {
  it('maps enqueue options to BullMQ job options and wraps the payload in an envelope', async () => {
    const q = new BullMqJobQueue(REDIS_URL);

    const result = await q.enqueue(
      queue('demo'),
      { value: 'hi' },
      {
        idempotencyKey: 'k1',
        delayMs: 5000,
        attempts: 3,
        backoff: { type: 'exponential', delayMs: 500 },
        priority: 2,
        meta: { correlationId: 'c1' },
      },
    );

    expect(result).toEqual({ id: 'job-1' });
    expect(queues[0]?.add).toHaveBeenCalledTimes(1);
    expect(queues[0]?.add).toHaveBeenCalledWith(
      'demo',
      { payload: { value: 'hi' }, meta: { correlationId: 'c1', idempotencyKey: 'k1' } },
      {
        jobId: 'k1',
        delay: 5000,
        attempts: 3,
        backoff: { type: 'exponential', delay: 500 },
        priority: 2,
      },
    );
  });

  it('returns the BullMQ-assigned id when no idempotencyKey is given', async () => {
    const q = new BullMqJobQueue(REDIS_URL);
    const result = await q.enqueue(queue('demo'), { value: 'hi' });

    expect(result).toEqual({ id: 'job-1' });
    expect(queues[0]?.add).toHaveBeenCalledWith(
      'demo',
      { payload: { value: 'hi' }, meta: { idempotencyKey: undefined } },
      {
        jobId: undefined,
        delay: undefined,
        attempts: undefined,
        backoff: undefined,
        priority: undefined,
      },
    );
  });

  it('validates the payload and builds a JobContext with attempt = attemptsMade + 1 and carried meta', async () => {
    const q = new BullMqJobQueue(REDIS_URL);
    const seen: Array<Record<string, unknown>> = [];
    q.registerWorker({
      queue: queue('demo'),
      schema: Payload,
      handler: (ctx) => {
        seen.push({ ...ctx });
      },
    });

    await workers[0]?.processor({
      id: 'j1',
      name: 'demo',
      data: { payload: { value: 'hi' }, meta: { idempotencyKey: 'k1' } },
      attemptsMade: 1,
      timestamp: 1000,
      opts: { attempts: 3 },
    });

    expect(seen[0]).toEqual({
      id: 'j1',
      name: 'demo',
      payload: { value: 'hi' },
      attempt: 2,
      enqueuedAt: new Date(1000),
      meta: { idempotencyKey: 'k1' },
    });
  });

  it('fails the job when the payload does not match the schema', async () => {
    const q = new BullMqJobQueue(REDIS_URL);
    q.registerWorker({ queue: queue('demo'), schema: Payload, handler: () => undefined });

    await expect(
      workers[0]?.processor({
        id: 'j1',
        name: 'demo',
        data: { payload: { value: 42 }, meta: {} },
        attemptsMade: 0,
        timestamp: 1000,
        opts: { attempts: 1 },
      }),
    ).rejects.toThrow();
  });

  it('passes worker concurrency through to BullMQ', () => {
    const q = new BullMqJobQueue(REDIS_URL);
    q.registerWorker({
      queue: queue('demo'),
      schema: Payload,
      handler: () => undefined,
      options: { concurrency: 5 },
    });
    expect(workers[0]?.opts.concurrency).toBe(5);
  });

  it('dead-letters only on terminal failure and swallows a throwing hook', async () => {
    const q = new BullMqJobQueue(REDIS_URL);
    const onDeadLetter = vi.fn(async () => {
      throw new Error('hook boom');
    });
    q.registerWorker({
      queue: queue('demo'),
      schema: Payload,
      handler: () => undefined,
      onDeadLetter,
    });
    const failed = workers[0]?.handlers.get('failed');
    const err = new Error('boom');
    const job: FakeJob = {
      id: 'j1',
      name: 'demo',
      data: { payload: { value: 'hi' }, meta: { idempotencyKey: 'k1' } },
      attemptsMade: 1,
      timestamp: 1000,
      opts: { attempts: 3 },
    };

    failed?.(job, err);
    await flush();
    expect(onDeadLetter).not.toHaveBeenCalled();

    failed?.({ ...job, attemptsMade: 3 }, err);
    await flush();
    expect(onDeadLetter).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'j1',
        name: 'demo',
        attempt: 3,
        payload: { value: 'hi' },
        meta: { idempotencyKey: 'k1' },
      }),
      err,
    );
  });

  it('maps a cron schedule to a job scheduler and unschedules by id', async () => {
    const q = new BullMqJobQueue(REDIS_URL);

    await q.schedule(
      queue('sched'),
      'daily',
      { value: 'x' },
      { cron: '0 0 * * *', timezone: 'UTC' },
    );
    expect(queues[0]?.upsertJobScheduler).toHaveBeenCalledWith(
      'daily',
      { pattern: '0 0 * * *', every: undefined, tz: 'UTC' },
      { name: 'sched', data: { payload: { value: 'x' }, meta: {} } },
    );

    await q.unschedule(queue('sched'), 'daily');
    expect(queues[0]?.removeJobScheduler).toHaveBeenCalledWith('daily');
  });

  it('maps an everyMs schedule to the every option', async () => {
    const q = new BullMqJobQueue(REDIS_URL);
    await q.schedule(queue('sched'), 'tick', { value: 'x' }, { everyMs: 60000 });
    expect(queues[0]?.upsertJobScheduler).toHaveBeenCalledWith(
      'tick',
      { pattern: undefined, every: 60000, tz: undefined },
      { name: 'sched', data: { payload: { value: 'x' }, meta: {} } },
    );
  });

  it('closes workers before queues', async () => {
    const q = new BullMqJobQueue(REDIS_URL);
    q.registerWorker({ queue: queue('demo'), schema: Payload, handler: () => undefined });
    await q.enqueue(queue('demo'), { value: 'hi' });

    await q.close();

    expect(closeOrder).toEqual(['worker', 'queue']);
  });
});

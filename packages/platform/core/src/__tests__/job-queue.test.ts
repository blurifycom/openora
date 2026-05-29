import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import type { Logger } from 'pino';
import { queue } from '@oss/adapters';
import { InProcessJobQueue } from '../job-queue.js';

function fakeLogger() {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const Payload = z.object({ value: z.string() });
type Payload = z.infer<typeof Payload>;

describe('InProcessJobQueue', () => {
  it('runs a worker handler with the validated payload', async () => {
    const q = new InProcessJobQueue(fakeLogger());
    const seen: Payload[] = [];
    q.registerWorker({
      queue: queue('demo'),
      schema: Payload,
      handler: (ctx) => {
        seen.push(ctx.payload);
      },
    });

    await q.enqueue(queue('demo'), { value: 'hi' });
    await flush();

    expect(seen).toEqual([{ value: 'hi' }]);
    await q.close();
  });

  it('buffers jobs enqueued before the worker registers, then flushes', async () => {
    const q = new InProcessJobQueue(fakeLogger());
    const seen: string[] = [];

    await q.enqueue(queue('late'), { value: 'a' });
    await flush();
    expect(seen).toEqual([]); // no worker yet -> buffered

    q.registerWorker({
      queue: queue('late'),
      schema: Payload,
      handler: (ctx) => {
        seen.push(ctx.payload.value);
      },
    });
    await flush();
    expect(seen).toEqual(['a']);
    await q.close();
  });

  it('retries with backoff then dead-letters after attempts exhausted', async () => {
    const q = new InProcessJobQueue(fakeLogger());
    const attempts: number[] = [];
    const dead = vi.fn();
    q.registerWorker({
      queue: queue('flaky'),
      schema: Payload,
      handler: (ctx) => {
        attempts.push(ctx.attempt);
        throw new Error('boom');
      },
      onDeadLetter: dead,
    });

    await q.enqueue(queue('flaky'), { value: 'x' }, {
      attempts: 3,
      backoff: { type: 'fixed', delayMs: 1 },
    });
    await wait(20);

    expect(attempts).toEqual([1, 2, 3]);
    expect(dead).toHaveBeenCalledOnce();
    expect((dead.mock.calls[0]![1] as Error).message).toBe('boom');
    await q.close();
  });

  it('serializes jobs that share an orderingKey', async () => {
    const q = new InProcessJobQueue(fakeLogger());
    const order: string[] = [];
    q.registerWorker({
      queue: queue('ordered'),
      schema: Payload,
      options: { serializeByOrderingKey: true },
      handler: async (ctx) => {
        order.push(`start:${ctx.payload.value}`);
        // First job sleeps longer; if not serialized it would finish last.
        await wait(ctx.payload.value === 'first' ? 10 : 1);
        order.push(`end:${ctx.payload.value}`);
      },
    });

    await q.enqueue(queue('ordered'), { value: 'first' }, { orderingKey: 'wallet-1' });
    await q.enqueue(queue('ordered'), { value: 'second' }, { orderingKey: 'wallet-1' });
    await wait(40);

    expect(order).toEqual(['start:first', 'end:first', 'start:second', 'end:second']);
    await q.close();
  });

  it('dedupes a duplicate enqueue while the idempotency key is active', async () => {
    const q = new InProcessJobQueue(fakeLogger());
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    q.registerWorker({
      queue: queue('money'),
      schema: Payload,
      handler: async () => {
        calls++;
        await gate;
      },
    });

    const a = await q.enqueue(queue('money'), { value: 'p' }, { idempotencyKey: 'pay-1' });
    await flush(); // first job is now in-flight, key still active
    const b = await q.enqueue(queue('money'), { value: 'p' }, { idempotencyKey: 'pay-1' });

    expect(b.id).toBe(a.id); // deduped to the same job
    release();
    await flush();
    expect(calls).toBe(1);
    await q.close();
  });

  it('drains in-flight work on close()', async () => {
    const q = new InProcessJobQueue(fakeLogger());
    let finished = false;
    q.registerWorker({
      queue: queue('drain'),
      schema: Payload,
      handler: async () => {
        await wait(15);
        finished = true;
      },
    });

    await q.enqueue(queue('drain'), { value: 'z' });
    await flush(); // ensure the job started
    await q.close(); // must await the in-flight handler
    expect(finished).toBe(true);
  });
});

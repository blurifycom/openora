import { ORPCError } from '@orpc/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACCESS_REVOKED_SIGNAL } from '@openora/core/contracts';
import type { RealtimeClientStatus } from '../context/realtime-client.js';
import {
  createSseRealtimeClientAdapter,
  type RealtimeStreamEvent,
} from '../context/sse-realtime-client.js';

type OpenResult = AsyncIterable<RealtimeStreamEvent<unknown>>;

const controllableStream = () => {
  const queue: RealtimeStreamEvent<unknown>[] = [];
  let wake: (() => void) | null = null;
  let finished = false;
  const iterable: OpenResult = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        if (finished) {
          return;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
  return {
    iterable,
    push(event: RealtimeStreamEvent<unknown>) {
      queue.push(event);
      wake?.();
    },
    end() {
      finished = true;
      wake?.();
    },
  };
};

type Behavior = OpenResult | Error;

const setup = (behaviors: Behavior[]) => {
  const signals: AbortSignal[] = [];
  const times: number[] = [];
  const open = vi.fn((_channel: string, signal: AbortSignal) => {
    signals.push(signal);
    times.push(Date.now());
    const behavior = behaviors[Math.min(open.mock.calls.length - 1, behaviors.length - 1)];
    return behavior instanceof Error ? Promise.reject(behavior) : Promise.resolve(behavior);
  });
  const adapter = createSseRealtimeClientAdapter({ open });
  const statuses: RealtimeClientStatus[] = [];
  const handlers = {
    onMessage: vi.fn(),
    onSignal: vi.fn(),
    onStatus: (status: RealtimeClientStatus) => statuses.push(status),
  };
  return { adapter, open, signals, times, statuses, handlers };
};

const flush = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

describe('sse realtime client', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports connecting then open on every reconnect', async () => {
    const first = controllableStream();
    const second = controllableStream();
    const { adapter, statuses, handlers, open } = setup([first.iterable, second.iterable]);
    adapter.subscribe('room', handlers);
    await flush();
    expect(statuses).toEqual(['connecting', 'open']);

    first.end();
    await flush();
    expect(statuses).toEqual(['connecting', 'open', 'connecting']);

    await flush(1_000);
    expect(open).toHaveBeenCalledTimes(2);
    expect(statuses).toEqual(['connecting', 'open', 'connecting', 'open']);
  });

  it('reconnects with exponential backoff after a dropped stream', async () => {
    const { adapter, times, handlers } = setup([new Error('network down')]);
    adapter.subscribe('room', handlers);
    await flush(61_000);
    expect(times).toEqual([0, 1_000, 3_000, 7_000, 15_000, 31_000, 61_000]);
  });

  it.each([400, 401, 403, 404, 410])(
    'a %i error stops the channel until the next subscribe',
    async (status) => {
      const { adapter, open, statuses, handlers } = setup([
        new ORPCError('FAILED', { status }),
        controllableStream().iterable,
      ]);
      adapter.subscribe('room', handlers);
      await flush(120_000);
      expect(open).toHaveBeenCalledTimes(1);
      expect(statuses.at(-1)).toBe('closed');

      adapter.subscribe('room', { onMessage: vi.fn() });
      await flush();
      expect(open).toHaveBeenCalledTimes(2);
      expect(statuses.at(-1)).toBe('open');
    },
  );

  it.each([408, 429, 500, 503])('a %i error reconnects', async (status) => {
    const { adapter, open, statuses, handlers } = setup([
      new ORPCError('FAILED', { status }),
      controllableStream().iterable,
    ]);
    adapter.subscribe('room', handlers);
    await flush();
    expect(open).toHaveBeenCalledTimes(1);
    expect(statuses.at(-1)).toBe('connecting');
    await flush(1_000);
    expect(open).toHaveBeenCalledTimes(2);
    expect(statuses.at(-1)).toBe('open');
  });

  it('the access revoked signal closes the channel without reconnecting', async () => {
    const stream = controllableStream();
    const { adapter, open, signals, statuses, handlers } = setup([stream.iterable]);
    adapter.subscribe('room', handlers);
    await flush();
    stream.push({ type: 'signal', signal: { name: ACCESS_REVOKED_SIGNAL, payload: { why: 1 } } });
    await flush(120_000);
    expect(handlers.onSignal).toHaveBeenCalledWith(ACCESS_REVOKED_SIGNAL, { why: 1 });
    expect(signals[0]?.aborted).toBe(true);
    expect(statuses.at(-1)).toBe('closed');
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('the last unsubscribe closes the stream after the grace delay', async () => {
    const { adapter, signals, handlers } = setup([controllableStream().iterable]);
    const offFirst = adapter.subscribe('room', handlers);
    const offSecond = adapter.subscribe('room', { onMessage: vi.fn() });
    await flush();

    offFirst();
    await flush(1_000);
    expect(signals[0]?.aborted).toBe(false);

    offSecond();
    expect(signals[0]?.aborted).toBe(false);
    await flush();
    expect(signals[0]?.aborted).toBe(true);
  });

  it('a resubscribe within the grace delay keeps the stream open', async () => {
    const { adapter, open, signals, handlers } = setup([controllableStream().iterable]);
    const off = adapter.subscribe('room', handlers);
    await flush();

    off();
    const statuses: RealtimeClientStatus[] = [];
    adapter.subscribe('room', { onMessage: vi.fn(), onStatus: (s) => statuses.push(s) });
    await flush(1_000);
    expect(open).toHaveBeenCalledTimes(1);
    expect(signals[0]?.aborted).toBe(false);
    expect(statuses).toEqual(['open']);
  });

  it('refresh reopens a stopped channel', async () => {
    const { adapter, open, statuses, handlers } = setup([
      new ORPCError('FORBIDDEN', { status: 403 }),
      controllableStream().iterable,
    ]);
    adapter.subscribe('room', handlers);
    await flush(60_000);
    expect(statuses.at(-1)).toBe('closed');
    expect(open).toHaveBeenCalledTimes(1);

    adapter.refresh?.();
    await flush();
    expect(open).toHaveBeenCalledTimes(2);
    expect(statuses.at(-1)).toBe('open');
  });
});

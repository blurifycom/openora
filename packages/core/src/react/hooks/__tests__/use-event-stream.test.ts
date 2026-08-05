// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEventStream } from '../use-event-stream.js';

type Controllable<T> = {
  iterable: AsyncIterable<T>;
  push: (event: T) => void;
  end: () => void;
};

function createControllableIterable<T>(): Controllable<T> {
  const queue: T[] = [];
  let resolveNext: (() => void) | null = null;
  let done = false;

  const wake = () => {
    resolveNext?.();
    resolveNext = null;
  };

  const iterable: AsyncIterable<T> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<T>> {
          while (queue.length === 0 && !done) {
            await new Promise<void>((resolve) => {
              resolveNext = resolve;
            });
          }
          if (queue.length > 0) {
            return { value: queue.shift() as T, done: false };
          }
          return { value: undefined, done: true };
        },
      };
    },
  };

  return {
    iterable,
    push: (event) => {
      queue.push(event);
      wake();
    },
    end: () => {
      done = true;
      wake();
    },
  };
}

function endedIterable<T>(): AsyncIterable<T> {
  const stream = createControllableIterable<T>();
  stream.end();
  return stream.iterable;
}

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('useEventStream', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('goes idle -> connecting -> open and delivers events', async () => {
    const stream = createControllableIterable<{ id: number }>();
    const subscribe = vi.fn().mockResolvedValue(stream.iterable);

    const { result } = renderHook(() => useEventStream(subscribe));
    expect(result.current.status).toBe('connecting');

    await flush();
    expect(result.current.status).toBe('open');

    await act(async () => {
      stream.push({ id: 1 });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.last).toEqual({ id: 1 });
  });

  it('grows the retry delay on repeated accept-then-immediate-drop cycles instead of pinning it at 1s', async () => {
    const callTimes: number[] = [];
    const subscribe = vi.fn().mockImplementation(async () => {
      callTimes.push(Date.now());
      return endedIterable();
    });

    renderHook(() => useEventStream(subscribe));

    await flush();
    await flush(1_000);
    await flush(2_000);
    await flush(4_000);

    expect(callTimes).toHaveLength(4);
    expect(callTimes[1]! - callTimes[0]!).toBe(1_000);
    expect(callTimes[2]! - callTimes[1]!).toBe(2_000);
    expect(callTimes[3]! - callTimes[2]!).toBe(4_000);
  });

  it('surfaces status "closed" on an unexpected drop, before the next reconnect attempt', async () => {
    const subscribe = vi.fn().mockImplementation(async () => endedIterable());

    const { result } = renderHook(() => useEventStream(subscribe));

    await flush();
    expect(result.current.status).toBe('closed');
  });

  it('resets the backoff once a connection has stayed open past the stability window', async () => {
    const callTimes: number[] = [];
    let call = 0;
    const streams: Controllable<unknown>[] = [];
    const subscribe = vi.fn().mockImplementation(async () => {
      callTimes.push(Date.now());
      call += 1;
      if (call === 1) {
        // First cycle: accepted then dropped immediately - retryCount -> 1, next delay 1000ms.
        return endedIterable();
      }
      // Second cycle: stays open - the test advances past the stability window before ending it.
      const stream = createControllableIterable();
      streams.push(stream);
      return stream.iterable;
    });

    renderHook(() => useEventStream(subscribe));

    await flush(); // cycle 1 opens then immediately closes
    await flush(1_000); // cycle 2 starts (base 1s delay confirms cycle 1 pinned retryCount at 1)

    // Let cycle 2 earn stability (5s), then end it - a genuinely reset backoff
    // reconnects at the base 1s delay again, not 2000ms (2^1).
    await flush(5_000);
    await act(async () => {
      streams[0]?.end();
      await vi.advanceTimersByTimeAsync(0);
    });
    await flush(1_000);

    expect(callTimes).toHaveLength(3);
    expect(callTimes[1]! - callTimes[0]!).toBe(1_000);
    expect(callTimes[2]! - callTimes[1]!).toBe(6_000); // 5s stabilizing + 1s reset-base retry
  });

  it('does not schedule a reconnect on intentional teardown', async () => {
    const stream = createControllableIterable();
    const subscribe = vi.fn().mockResolvedValue(stream.iterable);

    const { unmount } = renderHook(() => useEventStream(subscribe));
    await flush();
    expect(subscribe).toHaveBeenCalledOnce();

    unmount();
    await flush(60_000);
    expect(subscribe).toHaveBeenCalledOnce();
  });

  it('tears down without reconnecting when disabled, and resumes cleanly once re-enabled', async () => {
    const subscribe = vi.fn().mockImplementation(async () => createControllableIterable().iterable);

    const { result, rerender } = renderHook(
      ({ enabled }) => useEventStream(subscribe, { enabled }),
      {
        initialProps: { enabled: true },
      },
    );
    await flush();
    expect(result.current.status).toBe('open');
    expect(subscribe).toHaveBeenCalledOnce();

    rerender({ enabled: false });
    expect(result.current.status).toBe('idle');

    await flush(60_000);
    expect(subscribe).toHaveBeenCalledOnce();

    rerender({ enabled: true });
    await flush();
    expect(result.current.status).toBe('open');
    expect(subscribe).toHaveBeenCalledTimes(2);
  });
});

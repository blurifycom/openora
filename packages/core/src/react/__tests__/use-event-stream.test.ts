import { createRequire } from 'node:module';
import { act, createElement, type ReactElement } from 'react';
import type { Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useEventStream,
  type EventStreamStatus,
  type UseEventStreamOptions,
} from '../hooks/use-event-stream.js';

type Subscribe = (signal: AbortSignal) => Promise<AsyncIterable<string>>;

const controllableStream = () => {
  const queue: string[] = [];
  let wake: (() => void) | null = null;
  let finished = false;
  const iterable: AsyncIterable<string> = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const next = queue.shift();
        if (next !== undefined) {
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
    push(event: string) {
      queue.push(event);
      wake?.();
    },
    end() {
      finished = true;
      wake?.();
    },
  };
};

const loadJsdomWindow = (): { window: object; close: () => void } => {
  const mod: unknown = createRequire(import.meta.url)('jsdom');
  const ctor = typeof mod === 'object' && mod !== null ? Reflect.get(mod, 'JSDOM') : undefined;
  if (typeof ctor !== 'function') {
    throw new Error('jsdom is not available');
  }
  const dom: unknown = Reflect.construct(ctor, ['<!doctype html><body></body>']);
  const window = typeof dom === 'object' && dom !== null ? Reflect.get(dom, 'window') : undefined;
  if (typeof window !== 'object' || window === null) {
    throw new Error('jsdom window is not available');
  }
  return { window, close: () => Reflect.apply(Reflect.get(window, 'close'), window, []) };
};

type Seen = { status: EventStreamStatus; last: string | null };

const setup = (streams: ReturnType<typeof controllableStream>[]) => {
  const signals: AbortSignal[] = [];
  const times: number[] = [];
  let calls = 0;
  const subscribe = vi.fn<Subscribe>((signal) => {
    signals.push(signal);
    times.push(Date.now());
    const stream = streams[Math.min(calls, streams.length - 1)];
    calls += 1;
    return Promise.resolve(stream.iterable);
  });
  return { subscribe, signals, times };
};

describe('useEventStream', () => {
  let createRoot: (container: Element) => Root;
  let dom: ReturnType<typeof loadJsdomWindow>;
  let root: Root;
  let seen: Seen;
  const statuses: EventStreamStatus[] = [];

  const Probe = (props: { subscribe: Subscribe; options: UseEventStreamOptions<string> }) => {
    const result = useEventStream(props.subscribe, props.options);
    seen = result;
    if (statuses.at(-1) !== result.status) {
      statuses.push(result.status);
    }
    return null;
  };

  const render = async (element: ReactElement) => {
    await act(async () => {
      root.render(element);
    });
  };

  const mount = (subscribe: Subscribe, options: UseEventStreamOptions<string> = {}) =>
    render(createElement(Probe, { subscribe, options }));

  const advance = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });

  beforeAll(async () => {
    dom = loadJsdomWindow();
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', Reflect.get(dom.window, 'document'));
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    ({ createRoot } = await import('react-dom/client'));
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    dom.close();
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    statuses.length = 0;
    seen = { status: 'idle', last: null };
    root = createRoot(document.createElement('div'));
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    vi.useRealTimers();
  });

  it('stays idle and opens no stream when disabled', async () => {
    const { subscribe } = setup([controllableStream()]);
    await mount(subscribe, { enabled: false });
    await advance(60_000);
    expect(subscribe).not.toHaveBeenCalled();
    expect(statuses).toEqual(['idle']);
  });

  it('moves from connecting to open once the stream is accepted and delivers each event to onEvent', async () => {
    const stream = controllableStream();
    const { subscribe } = setup([stream]);
    const onEvent = vi.fn();
    await mount(subscribe, { onEvent });
    expect(statuses).toEqual(['idle', 'connecting', 'open']);
    expect(seen.last).toBeNull();

    await act(async () => {
      stream.push('first');
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(onEvent).toHaveBeenCalledWith('first');
    expect(seen).toEqual({ status: 'open', last: 'first' });
  });

  it('reconnects with exponential backoff capped at the max delay after an unexpected close', async () => {
    const streams = Array.from({ length: 8 }, () => {
      const stream = controllableStream();
      stream.end();
      return stream;
    });
    const { subscribe, times } = setup(streams);
    await mount(subscribe);
    await advance(61_000);
    expect(times).toEqual([0, 1_000, 3_000, 7_000, 15_000, 31_000, 61_000]);
    expect(seen.status).toBe('closed');
  });

  it('resets the backoff only after a connection has stayed open', async () => {
    const delayAfterSecondConnection = async (openForMs: number) => {
      const first = controllableStream();
      first.end();
      const second = controllableStream();
      const { subscribe, times } = setup([first, second, controllableStream()]);
      await mount(subscribe);
      await advance(1_000);
      await advance(openForMs);
      second.end();
      await advance(0);
      const closedAt = Date.now();
      await advance(10_000);
      await act(async () => {
        root.unmount();
      });
      return (times[2] ?? Number.NaN) - closedAt;
    };

    expect(await delayAfterSecondConnection(6_000)).toBe(1_000);
    root = createRoot(document.createElement('div'));
    expect(await delayAfterSecondConnection(4_000)).toBe(2_000);
  });

  it('does not reconnect after an intentional teardown', async () => {
    const stream = controllableStream();
    const { subscribe } = setup([stream]);
    await mount(subscribe);
    await act(async () => {
      root.unmount();
    });
    stream.end();
    await advance(120_000);
    expect(subscribe).toHaveBeenCalledTimes(1);

    root = createRoot(document.createElement('div'));
    await mount(subscribe, { enabled: true });
    await mount(subscribe, { enabled: false });
    const callsWhenDisabled = subscribe.mock.calls.length;
    await advance(120_000);
    expect(subscribe).toHaveBeenCalledTimes(callsWhenDisabled);
  });

  it('aborts the stream and clears the retry timer on unmount', async () => {
    const first = controllableStream();
    const { subscribe, signals } = setup([first, controllableStream()]);
    await mount(subscribe);
    expect(signals[0]?.aborted).toBe(false);
    await act(async () => {
      root.unmount();
    });
    expect(signals[0]?.aborted).toBe(true);

    root = createRoot(document.createElement('div'));
    const dropped = controllableStream();
    dropped.end();
    const second = setup([dropped]);
    await mount(second.subscribe);
    expect(seen.status).toBe('closed');
    await act(async () => {
      root.unmount();
    });
    await advance(120_000);
    expect(second.subscribe).toHaveBeenCalledTimes(1);
  });
});

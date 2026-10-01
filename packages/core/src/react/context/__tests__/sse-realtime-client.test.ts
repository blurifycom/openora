import { ORPCError } from '@orpc/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACCESS_REVOKED_SIGNAL } from '@openora/core/contracts';
import {
  createSseRealtimeClientAdapter,
  type RealtimeStreamEvent,
} from '../sse-realtime-client.js';
import type { RealtimeClientStatus } from '../realtime-client.js';

type Event = RealtimeStreamEvent<unknown>;
type OpenedStream = {
  channel: string;
  signal: AbortSignal;
  push: (event: Event) => void;
  end: () => void;
};

function fakeServer() {
  const opened: OpenedStream[] = [];
  const open = vi.fn((channel: string, signal: AbortSignal) => {
    const events: Event[] = [];
    let wake: (() => void) | undefined;
    let ended = false;
    const waitForMore = () =>
      new Promise<void>((resolve) => {
        wake = resolve;
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    async function* iterate(): AsyncGenerator<Event> {
      while (!ended && !signal.aborted) {
        const next = events.shift();
        if (next) {
          yield next;
          continue;
        }
        await waitForMore();
      }
    }
    opened.push({
      channel,
      signal,
      push: (event) => {
        events.push(event);
        wake?.();
      },
      end: () => {
        ended = true;
        wake?.();
      },
    });
    return Promise.resolve(iterate());
  });
  const latest = () => {
    const stream = opened.at(-1);
    if (!stream) {
      throw new Error('no stream opened');
    }
    return stream;
  };
  return { open, opened, latest };
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const roleChanged: Event = {
  type: 'signal',
  signal: { name: 'chat:member-role-changed', payload: { role: 'moderator' } },
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createSseRealtimeClientAdapter', () => {
  it('keeps the lanes apart: messages reach onMessage, signals reach onSignal', async () => {
    const server = fakeServer();
    const adapter = createSseRealtimeClientAdapter({ open: server.open });
    const onMessage = vi.fn();
    const onSignal = vi.fn();

    adapter.subscribe('chat:room:r1', { onMessage, onSignal });
    await flush();
    server.latest().push({ type: 'message', message: { id: 'm1' } });
    server.latest().push(roleChanged);
    await flush();

    expect(onMessage.mock.calls).toEqual([[{ id: 'm1' }]]);
    expect(onSignal.mock.calls).toEqual([['chat:member-role-changed', { role: 'moderator' }]]);
  });

  it('shares one connection between subscribers of the same channel', async () => {
    const server = fakeServer();
    const adapter = createSseRealtimeClientAdapter({ open: server.open });
    const first = vi.fn();
    const second = vi.fn();
    const secondStatus = vi.fn();

    adapter.subscribe('chat:global', { onMessage: first });
    await flush();
    adapter.subscribe('chat:global', { onMessage: second, onStatus: secondStatus });
    server.latest().push({ type: 'message', message: 'hello' });
    await flush();

    expect(server.open).toHaveBeenCalledOnce();
    expect(first.mock.calls).toEqual([['hello']]);
    expect(second.mock.calls).toEqual([['hello']]);
    expect(secondStatus.mock.calls).toEqual([['open']]);
  });

  it('reconnects with backoff after the stream ends, reporting connecting then open', async () => {
    const server = fakeServer();
    const adapter = createSseRealtimeClientAdapter({ open: server.open });
    const statuses: RealtimeClientStatus[] = [];

    adapter.subscribe('chat:global', {
      onMessage: () => {},
      onStatus: (status) => statuses.push(status),
    });
    await flush();
    server.latest().end();
    await flush();
    expect(server.open).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(server.open).toHaveBeenCalledTimes(2);
    expect(statuses).toEqual(['connecting', 'open', 'connecting', 'open']);
  });

  it('retries a transient failure but stops on a 4xx until refresh', async () => {
    const server = fakeServer();
    const open = vi
      .fn(server.open)
      .mockRejectedValueOnce(new TypeError('network down'))
      .mockRejectedValueOnce(new ORPCError('FORBIDDEN'));
    const adapter = createSseRealtimeClientAdapter({ open });
    const statuses: RealtimeClientStatus[] = [];

    adapter.subscribe('chat:room:r1', {
      onMessage: () => {},
      onStatus: (status) => statuses.push(status),
    });
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(open).toHaveBeenCalledTimes(2);
    expect(statuses.at(-1)).toBe('closed');

    adapter.refresh?.();
    await flush();
    expect(open).toHaveBeenCalledTimes(3);
    expect(statuses.at(-1)).toBe('open');
  });

  it('on access revoked delivers the signal, reports closed and never reconnects', async () => {
    const server = fakeServer();
    const adapter = createSseRealtimeClientAdapter({ open: server.open });
    const onSignal = vi.fn();
    const statuses: RealtimeClientStatus[] = [];

    adapter.subscribe('chat:room:r1', {
      onMessage: () => {},
      onSignal,
      onStatus: (status) => statuses.push(status),
    });
    await flush();
    const stream = server.latest();
    stream.push({
      type: 'signal',
      signal: { name: ACCESS_REVOKED_SIGNAL, payload: { channel: 'chat:room:r1' } },
    });
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(onSignal.mock.calls).toEqual([[ACCESS_REVOKED_SIGNAL, { channel: 'chat:room:r1' }]]);
    expect(statuses.at(-1)).toBe('closed');
    expect(stream.signal.aborted).toBe(true);
    expect(server.open).toHaveBeenCalledOnce();
  });

  it('opens a fresh connection when the channel is subscribed again after a revocation', async () => {
    const server = fakeServer();
    const adapter = createSseRealtimeClientAdapter({ open: server.open });

    const unsubscribe = adapter.subscribe('chat:room:r1', { onMessage: () => {} });
    await flush();
    server.latest().push({
      type: 'signal',
      signal: { name: ACCESS_REVOKED_SIGNAL, payload: { channel: 'chat:room:r1' } },
    });
    await flush();
    unsubscribe();

    const onMessage = vi.fn();
    adapter.subscribe('chat:room:r1', { onMessage });
    await flush();
    server.latest().push({ type: 'message', message: 'back' });
    await flush();

    expect(server.open).toHaveBeenCalledTimes(2);
    expect(onMessage.mock.calls).toEqual([['back']]);
  });

  it('aborts the connection once the last subscriber leaves', async () => {
    const server = fakeServer();
    const adapter = createSseRealtimeClientAdapter({ open: server.open });

    const first = adapter.subscribe('chat:global', { onMessage: () => {} });
    const second = adapter.subscribe('chat:global', { onMessage: () => {} });
    await flush();
    first();
    await flush();
    expect(server.latest().signal.aborted).toBe(false);

    second();
    await flush();
    expect(server.latest().signal.aborted).toBe(true);
  });

  it('keeps the connection across an immediate unsubscribe and resubscribe', async () => {
    const server = fakeServer();
    const adapter = createSseRealtimeClientAdapter({ open: server.open });

    adapter.subscribe('chat:global', { onMessage: () => {} })();
    adapter.subscribe('chat:global', { onMessage: () => {} });
    await flush();

    expect(server.open).toHaveBeenCalledOnce();
    expect(server.latest().signal.aborted).toBe(false);
  });

  it('close aborts every open connection', async () => {
    const server = fakeServer();
    const adapter = createSseRealtimeClientAdapter({ open: server.open });

    adapter.subscribe('chat:global', { onMessage: () => {} });
    adapter.subscribe('chat:room:r1', { onMessage: () => {} });
    await flush();
    adapter.close?.();
    await flush();

    expect(server.opened.map((stream) => stream.signal.aborted)).toEqual([true, true]);
  });
});

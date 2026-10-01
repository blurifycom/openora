import { ORPCError } from '@orpc/client';
import { ACCESS_REVOKED_SIGNAL } from '@openora/core/contracts';
import type {
  RealtimeClientAdapter,
  RealtimeClientStatus,
  RealtimeSubscribeHandlers,
} from './realtime-client.js';

export type RealtimeStreamEvent<T> =
  | { type: 'message'; message: T }
  | { type: 'signal'; signal: { name: string; payload?: unknown } };

export type SseRealtimeClientAdapterOptions = {
  /** A 4xx `ORPCError` (other than 408/429) stops the channel until the next `subscribe` or `refresh`; anything else reconnects. */
  open: (
    channel: string,
    signal: AbortSignal,
  ) => Promise<AsyncIterable<RealtimeStreamEvent<unknown>>>;
};

type Subscriber = {
  onMessage: (event: unknown) => void;
  onSignal?: (name: string, payload: unknown) => void;
  onStatus?: (status: RealtimeClientStatus) => void;
};

type ChannelStream = {
  subscribers: Set<Subscriber>;
  status: RealtimeClientStatus;
  controller: AbortController | null;
  retryCount: number;
  retryTimer?: ReturnType<typeof setTimeout>;
  teardownTimer?: ReturnType<typeof setTimeout>;
};

const BASE_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;
const STABLE_CONNECTION_MS = 5_000;
const RETRYABLE_CLIENT_ERROR_STATUSES: ReadonlySet<number> = new Set([408, 429]);

function isFatal(error: unknown): boolean {
  return (
    error instanceof ORPCError &&
    error.status >= 400 &&
    error.status < 500 &&
    !RETRYABLE_CLIENT_ERROR_STATUSES.has(error.status)
  );
}

function notify(subscribers: Iterable<Subscriber>, deliver: (subscriber: Subscriber) => void) {
  for (const subscriber of Array.from(subscribers)) {
    try {
      deliver(subscriber);
    } catch (error) {
      queueMicrotask(() => {
        throw error;
      });
    }
  }
}

/** Reports `connecting` -> `open` on each reconnect so callers refetch what they missed; `ACCESS_REVOKED_SIGNAL` closes without reconnecting. */
export function createSseRealtimeClientAdapter({
  open,
}: SseRealtimeClientAdapterOptions): RealtimeClientAdapter {
  const streams = new Map<string, ChannelStream>();
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  const setStatus = (stream: ChannelStream, status: RealtimeClientStatus) => {
    if (stream.status === status) {
      return;
    }
    stream.status = status;
    notify(stream.subscribers, (subscriber) => subscriber.onStatus?.(status));
  };

  const stop = (stream: ChannelStream) => {
    clearTimeout(stream.retryTimer);
    clearTimeout(stream.teardownTimer);
    stream.controller?.abort();
    stream.controller = null;
  };

  const scheduleReconnect = (channel: string, stream: ChannelStream) => {
    setStatus(stream, 'connecting');
    const delay = Math.min(BASE_RETRY_DELAY_MS * 2 ** stream.retryCount, MAX_RETRY_DELAY_MS);
    stream.retryCount += 1;
    stream.retryTimer = setTimeout(() => connect(channel, stream), delay);
  };

  const revoke = (channel: string, stream: ChannelStream) => {
    stop(stream);
    if (streams.get(channel) === stream) {
      streams.delete(channel);
    }
    setStatus(stream, 'closed');
  };

  const dispatch = (
    channel: string,
    stream: ChannelStream,
    event: RealtimeStreamEvent<unknown>,
  ) => {
    if (event.type === 'message') {
      notify(stream.subscribers, (subscriber) => subscriber.onMessage(event.message));
      return;
    }
    const { name, payload } = event.signal;
    notify(stream.subscribers, (subscriber) => subscriber.onSignal?.(name, payload));
    if (name === ACCESS_REVOKED_SIGNAL) {
      revoke(channel, stream);
    }
  };

  const consume = async (channel: string, stream: ChannelStream, controller: AbortController) => {
    let stableTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const iterable = await open(channel, controller.signal);
      if (controller.signal.aborted) {
        return;
      }
      setStatus(stream, 'open');
      stableTimer = setTimeout(() => {
        stream.retryCount = 0;
      }, STABLE_CONNECTION_MS);
      for await (const event of iterable) {
        if (controller.signal.aborted) {
          return;
        }
        stream.retryCount = 0;
        dispatch(channel, stream, event);
        if (controller.signal.aborted) {
          return;
        }
      }
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      if (isFatal(error)) {
        stop(stream);
        setStatus(stream, 'closed');
        return;
      }
    } finally {
      clearTimeout(stableTimer);
    }
    if (!controller.signal.aborted) {
      scheduleReconnect(channel, stream);
    }
  };

  function connect(channel: string, stream: ChannelStream) {
    const controller = new AbortController();
    stream.controller = controller;
    setStatus(stream, 'connecting');
    void consume(channel, stream, controller);
  }

  const teardown = (channel: string, stream: ChannelStream) => {
    stop(stream);
    if (streams.get(channel) === stream) {
      streams.delete(channel);
    }
  };

  const restartStopped = () => {
    for (const [channel, stream] of streams) {
      if (stream.controller === null && stream.subscribers.size > 0) {
        stream.retryCount = 0;
        connect(channel, stream);
      }
    }
  };

  return {
    subscribe<T>(channel: string, handlers: RealtimeSubscribeHandlers<T>) {
      clearTimeout(closeTimer);
      const subscriber: Subscriber = {
        onMessage: (event) => handlers.onMessage(event as T),
        onSignal: handlers.onSignal,
        onStatus: handlers.onStatus,
      };

      const existing = streams.get(channel);
      const stream: ChannelStream = existing ?? {
        subscribers: new Set(),
        status: 'idle',
        controller: null,
        retryCount: 0,
      };
      clearTimeout(stream.teardownTimer);
      stream.subscribers.add(subscriber);
      if (!existing) {
        streams.set(channel, stream);
        connect(channel, stream);
      } else if (stream.controller === null) {
        stream.retryCount = 0;
        connect(channel, stream);
      } else {
        subscriber.onStatus?.(stream.status);
      }

      let active = true;
      return () => {
        if (!active) {
          return;
        }
        active = false;
        stream.subscribers.delete(subscriber);
        if (stream.subscribers.size > 0 || streams.get(channel) !== stream) {
          return;
        }
        stream.teardownTimer = setTimeout(() => {
          if (stream.subscribers.size === 0) {
            teardown(channel, stream);
          }
        }, 0);
      };
    },

    close() {
      clearTimeout(closeTimer);
      closeTimer = setTimeout(() => {
        for (const [channel, stream] of Array.from(streams)) {
          teardown(channel, stream);
        }
      }, 0);
    },

    refresh() {
      restartStopped();
    },
  };
}

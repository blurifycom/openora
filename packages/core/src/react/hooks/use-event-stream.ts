'use client';

import { useEffect, useRef, useState } from 'react';

export type EventStreamStatus = 'idle' | 'connecting' | 'open' | 'closed';

export type UseEventStreamOptions<T> = {
  /** When false, the stream is not opened (and an open one is torn down). */
  enabled?: boolean;
  /** Called for each event as it arrives, before state updates. */
  onEvent?: (event: T) => void;
};

export type UseEventStreamResult<T> = {
  last: T | null;
  status: EventStreamStatus;
};

const MAX_RETRY_DELAY_MS = 30_000;
const STABLE_CONNECTION_MS = 5_000;

/**
 * Generic client-side real-time transport. Consumes any async-iterable source
 * (eg an oRPC event iterator served as SSE: `client.x.stream(undefined, { signal })`).
 *
 * Owns an AbortController per active subscription, loops `for await` over the
 * iterable, calls `onEvent` and tracks the latest value + connection status.
 * Re-subscribes when `subscribe` identity changes, so memoize it at the call site.
 * Reconnects automatically with exponential backoff when the stream drops unexpectedly.
 */
export function useEventStream<T>(
  subscribe: (signal: AbortSignal) => Promise<AsyncIterable<T>>,
  options: UseEventStreamOptions<T> = {},
): UseEventStreamResult<T> {
  const { enabled = true, onEvent } = options;
  const [last, setLast] = useState<T | null>(null);
  const [status, setStatus] = useState<EventStreamStatus>('idle');

  // Keep the latest onEvent without forcing a re-subscribe each render.
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!enabled) {
      setStatus('idle');
      return;
    }

    let cancelled = false;
    let currentController: AbortController | null = null;
    let retryCount = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      const controller = new AbortController();
      currentController = controller;
      setStatus('connecting');

      (async () => {
        let stableTimer: ReturnType<typeof setTimeout> | undefined;
        let stabilized = false;
        const markStable = () => {
          if (stabilized) {
            return;
          }
          stabilized = true;
          retryCount = 0;
          clearTimeout(stableTimer);
        };

        try {
          const iterable = await subscribe(controller.signal);
          if (cancelled) {
            return;
          }
          setStatus('open');
          // Only trust this connection - and reset the backoff - once it has
          // stayed open a while or delivered something. Resetting the instant
          // subscribe() resolves means a connection accepted then dropped
          // immediately (idle-timeout proxy, server ending the generator
          // early) reconnects at a fixed ~1s delay forever instead of backing off.
          stableTimer = setTimeout(markStable, STABLE_CONNECTION_MS);
          for await (const event of iterable) {
            if (cancelled) {
              break;
            }
            markStable();
            onEventRef.current?.(event);
            setLast(event);
          }
        } catch (err) {
          // Intentional teardown — do not reconnect.
          if (cancelled || (err as Error)?.name === 'AbortError') {
            return;
          }
        } finally {
          clearTimeout(stableTimer);
          if (!cancelled) {
            // Unexpected close: reconnect with exponential backoff.
            setStatus('closed');
            const delay = Math.min(1000 * 2 ** retryCount, MAX_RETRY_DELAY_MS);
            retryCount += 1;
            retryTimer = setTimeout(connect, delay);
          }
        }
      })();
    };

    connect();

    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      currentController?.abort();
    };
  }, [subscribe, enabled]);

  return { last, status };
}

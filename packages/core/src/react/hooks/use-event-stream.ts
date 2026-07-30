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
        try {
          const iterable = await subscribe(controller.signal);
          if (cancelled) {
            return;
          }
          retryCount = 0;
          setStatus('open');
          for await (const event of iterable) {
            if (cancelled) {
              break;
            }
            onEventRef.current?.(event);
            setLast(event);
          }
        } catch (err) {
          // Intentional teardown — do not reconnect.
          if (cancelled || (err as Error)?.name === 'AbortError') {
            return;
          }
        } finally {
          if (!cancelled) {
            // Unexpected close: reconnect with exponential backoff.
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

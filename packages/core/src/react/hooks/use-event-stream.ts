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

/**
 * Generic client-side real-time transport. Consumes any async-iterable source
 * (eg an oRPC event iterator served as SSE: `client.x.stream(undefined, { signal })`).
 *
 * Owns an AbortController per active subscription, loops `for await` over the
 * iterable, calls `onEvent` and tracks the latest value + connection status,
 * and aborts on unmount or when `enabled` flips false. Re-subscribes when
 * `subscribe` identity changes, so memoize it at the call site.
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

    const controller = new AbortController();
    let cancelled = false;
    setStatus('connecting');

    (async () => {
      try {
        const iterable = await subscribe(controller.signal);
        if (cancelled) {
          return;
        }
        setStatus('open');
        for await (const event of iterable) {
          if (cancelled) {
            break;
          }
          onEventRef.current?.(event);
          setLast(event);
        }
      } catch (err) {
        // An AbortError on unmount/disable is expected teardown - swallow it.
        if (!cancelled && (err as Error)?.name !== 'AbortError') {
          // Stream closed; status is updated in finally.
        }
      } finally {
        if (!cancelled) {
          setStatus('closed');
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [subscribe, enabled]);

  return { last, status };
}

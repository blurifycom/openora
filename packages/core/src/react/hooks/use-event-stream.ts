'use client';

import { useEffect, useRef, useState } from 'react';

export type EventStreamStatus = 'idle' | 'connecting' | 'open' | 'closed';

export type UseEventStreamOptions<T> = {
  enabled?: boolean;
  onEvent?: (event: T) => void;
};

export type UseEventStreamResult<T> = {
  last: T | null;
  status: EventStreamStatus;
};

const MAX_RETRY_DELAY_MS = 30_000;
const STABLE_CONNECTION_MS = 5_000;

export function useEventStream<T>(
  subscribe: (signal: AbortSignal) => Promise<AsyncIterable<T>>,
  options: UseEventStreamOptions<T> = {},
): UseEventStreamResult<T> {
  const { enabled = true, onEvent } = options;
  const [last, setLast] = useState<T | null>(null);
  const [status, setStatus] = useState<EventStreamStatus>('idle');

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
          if (cancelled || (err as Error)?.name === 'AbortError') {
            return;
          }
        } finally {
          clearTimeout(stableTimer);
          if (!cancelled) {
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

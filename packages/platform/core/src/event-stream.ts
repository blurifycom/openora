/**
 * createEventStreamGenerator - turns a push-style subscription into a pull-style
 * async generator for oRPC SSE / event-iterator routes. A bounded buffer holds
 * events between yields; a resolver wakes the generator when one arrives. The
 * subscription is torn down (and the abort listener removed) when the consumer
 * stops or `signal` aborts, so each connection cleans up after itself.
 *
 * `subscribe` receives a `push` callback and returns its unsubscribe fn.
 * `prime` events (eg the latest known snapshot) are yielded before live events
 * so a fresh client paints immediately instead of waiting for the next tick.
 */
export interface EventStreamOptions<T> {
  signal?: AbortSignal;
  prime?: readonly T[];
}

export async function* createEventStreamGenerator<T>(
  subscribe: (push: (event: T) => void) => () => void,
  options: EventStreamOptions<T> = {},
): AsyncGenerator<T> {
  const { signal, prime = [] } = options;
  const queue: T[] = [...prime];
  let resolve: (() => void) | undefined;
  let done = false;

  const wake = () => {
    resolve?.();
    resolve = undefined;
  };

  const unsubscribe = subscribe((event) => {
    queue.push(event);
    wake();
  });

  const onAbort = () => {
    done = true;
    wake();
  };
  signal?.addEventListener('abort', onAbort);

  try {
    while (!done && !signal?.aborted) {
      if (queue.length === 0) {
        await new Promise<void>((r) => {
          resolve = r;
        });
        continue;
      }
      const next = queue.shift();
      if (next !== undefined) yield next;
    }
  } finally {
    unsubscribe();
    signal?.removeEventListener('abort', onAbort);
  }
}

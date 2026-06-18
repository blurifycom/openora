/**
 * Turns a push-style subscription into a pull-style async generator for oRPC SSE routes.
 * `prime` events are yielded first so a fresh client paints immediately.
 * Cleans up the subscription and abort listener when the consumer stops or `signal` fires.
 */
export type EventStreamOptions<T> = {
  signal?: AbortSignal;
  prime?: readonly T[];
};

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

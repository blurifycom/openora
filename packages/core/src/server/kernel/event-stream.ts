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

  // Abort can race the async iterator consumer. Clean up immediately and make
  // the operation idempotent so a later generator `finally` cannot re-run the
  // underlying subscription teardown.
  let cleanedUp = false;
  let onAbort = () => {};
  const cleanup = () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    unsubscribe();
    signal?.removeEventListener('abort', onAbort);
  };

  onAbort = () => {
    done = true;
    cleanup();
    wake();
  };

  if (signal?.aborted) {
    onAbort();
  } else {
    signal?.addEventListener('abort', onAbort, { once: true });
  }

  try {
    while (!done && !signal?.aborted) {
      if (queue.length === 0) {
        await new Promise<void>((r) => {
          resolve = r;
        });
        continue;
      }
      const next = queue.shift();
      if (next !== undefined) {
        yield next;
      }
    }
  } finally {
    cleanup();
  }
}

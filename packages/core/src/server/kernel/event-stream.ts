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

/** One channel folded into a multiplexed stream: a name the client dispatches on, plus how to subscribe to it. */
export type MultiplexedChannel<T> = {
  name: string;
  subscribe: (push: (event: T) => void) => () => void;
};

/** An event from a multiplexed stream, tagged with the channel name that produced it. */
export type MultiplexedEvent<T> = { channel: string; payload: T };

/**
 * Folds several independent push-subscriptions (eg one per-user realtime channel each) into a
 * single SSE-servable generator, so a browser opens one HTTP connection instead of one per
 * channel - the browser's per-origin connection cap otherwise starves ordinary API fetches
 * behind N permanently-open streams. Each event is tagged with the channel name that produced
 * it so the client can fan it back out to the right handler. Every channel subscribes for the
 * lifetime of the generator and is torn down together on `signal` abort or consumer stop.
 */
export function createMultiplexedEventStreamGenerator<T>(
  channels: ReadonlyArray<MultiplexedChannel<T>>,
  options: EventStreamOptions<MultiplexedEvent<T>> = {},
): AsyncGenerator<MultiplexedEvent<T>> {
  return createEventStreamGenerator<MultiplexedEvent<T>>((push) => {
    const unsubscribes = channels.map(({ name, subscribe }) =>
      subscribe((event) => push({ channel: name, payload: event })),
    );
    return () => {
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
    };
  }, options);
}

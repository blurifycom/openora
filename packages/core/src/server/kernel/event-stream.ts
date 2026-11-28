export type EventStreamOptions<T> = {
  signal?: AbortSignal;
  prime?: readonly T[];
  endAfter?: (event: T) => boolean;
  ready?: () => Promise<void>;
};

export async function* createEventStreamGenerator<T>(
  subscribe: (push: (event: T) => void) => () => void,
  options: EventStreamOptions<T> = {},
): AsyncGenerator<T> {
  const { signal, prime = [], endAfter, ready } = options;
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
    await ready?.();
    while (!done && !signal?.aborted) {
      if (queue.length === 0) {
        await new Promise<void>((r) => {
          resolve = r;
        });
        continue;
      }
      const next = queue.shift();
      if (next === undefined) {
        continue;
      }
      yield next;
      if (endAfter?.(next)) {
        return;
      }
    }
  } finally {
    cleanup();
  }
}

export type MultiplexedChannel<T> = {
  name: string;
  subscribe: (push: (event: T) => void) => () => void;
};

export type MultiplexedEvent<T> = { channel: string; payload: T };

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

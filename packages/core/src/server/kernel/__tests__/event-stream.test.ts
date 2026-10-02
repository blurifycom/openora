import { describe, it, expect } from 'vitest';
import {
  createEventStreamGenerator,
  createMultiplexedEventStreamGenerator,
} from '../event-stream.js';

async function collect<T>(iterable: AsyncGenerator<T>, count: number): Promise<T[]> {
  const results: T[] = [];
  for await (const event of iterable) {
    results.push(event);
    if (results.length >= count) {
      break;
    }
  }
  return results;
}

describe('createMultiplexedEventStreamGenerator', () => {
  it('tags each event with the channel name that produced it', async () => {
    let pushA: ((event: string) => void) | undefined;
    let pushB: ((event: string) => void) | undefined;

    const generator = createMultiplexedEventStreamGenerator<string>([
      { name: 'a', subscribe: (push) => ((pushA = push), () => {}) },
      { name: 'b', subscribe: (push) => ((pushB = push), () => {}) },
    ]);

    const resultPromise = collect(generator, 2);
    pushA?.('from-a');
    pushB?.('from-b');
    const results = await resultPromise;

    expect(results).toEqual([
      { channel: 'a', payload: 'from-a' },
      { channel: 'b', payload: 'from-b' },
    ]);
  });

  it('unsubscribes every folded channel when the abort signal fires', async () => {
    const unsubscribed: string[] = [];
    const controller = new AbortController();
    const generator = createMultiplexedEventStreamGenerator<string>(
      [
        { name: 'a', subscribe: () => () => unsubscribed.push('a') },
        { name: 'b', subscribe: () => () => unsubscribed.push('b') },
      ],
      { signal: controller.signal },
    );

    const nextPromise = generator.next();
    controller.abort();
    await nextPromise;

    expect(unsubscribed.sort()).toEqual(['a', 'b']);
  });

  it('stops yielding once the abort signal fires', async () => {
    const controller = new AbortController();
    const generator = createMultiplexedEventStreamGenerator<string>(
      [{ name: 'a', subscribe: () => () => {} }],
      { signal: controller.signal },
    );

    controller.abort();
    const next = await generator.next();

    expect(next.done).toBe(true);
  });
});

describe('createEventStreamGenerator', () => {
  it('ends after yielding the event endAfter matches, and unsubscribes', async () => {
    let push: ((event: string) => void) | undefined;
    let unsubscribed = false;
    const generator = createEventStreamGenerator<string>(
      (p) => {
        push = p;
        return () => {
          unsubscribed = true;
        };
      },
      { endAfter: (event) => event === 'last' },
    );

    const resultPromise = collect(generator, 10);
    push?.('first');
    push?.('last');
    push?.('after');

    expect(await resultPromise).toEqual(['first', 'last']);
    expect(unsubscribed).toBe(true);
  });

  it('subscribes before ready runs and delivers what arrived meanwhile', async () => {
    let push: ((event: string) => void) | undefined;
    const generator = createEventStreamGenerator<string>(
      (p) => {
        push = p;
        return () => {};
      },
      {
        ready: async () => {
          push?.('during-ready');
        },
      },
    );

    const resultPromise = collect(generator, 1);

    expect(await resultPromise).toEqual(['during-ready']);
  });

  it('ends with the ready rejection and unsubscribes', async () => {
    let unsubscribed = false;
    const generator = createEventStreamGenerator<string>(
      () => () => {
        unsubscribed = true;
      },
      { ready: () => Promise.reject(new Error('access revoked')) },
    );

    await expect(generator.next()).rejects.toThrow('access revoked');
    expect(unsubscribed).toBe(true);
  });
});

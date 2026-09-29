import { describe, it, expect } from 'vitest';
import { createMultiplexedEventStreamGenerator } from '../event-stream.js';

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

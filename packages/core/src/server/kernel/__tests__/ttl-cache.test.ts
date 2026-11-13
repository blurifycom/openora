import { describe, it, expect } from 'vitest';
import { TtlCache } from '../ttl-cache.js';

function setup(maxEntries = 3) {
  const clock = { now: 1_000 };
  const cache = new TtlCache<string, string[]>({ ttlMs: 100, maxEntries, now: () => clock.now });
  return { clock, cache };
}

describe('TtlCache', () => {
  it('serves an entry until its TTL elapses, then forgets it', () => {
    const { clock, cache } = setup();
    cache.set('a', 'one');

    clock.now += 99;
    expect(cache.get('a')).toBe('one');
    clock.now += 1;

    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('restarts the TTL when a key is set again', () => {
    const { clock, cache } = setup();
    cache.set('a', 'one');
    clock.now += 90;
    cache.set('a', 'two');
    clock.now += 90;

    expect(cache.get('a')).toBe('two');
  });

  it('drops the oldest entry past its bound', () => {
    const { cache } = setup(2);
    cache.set('a', '1');
    cache.set('b', '2');
    cache.set('a', '1 again');
    cache.set('c', '3');

    expect([cache.get('a'), cache.get('b'), cache.get('c')]).toEqual(['1 again', undefined, '3']);
    expect(cache.size).toBe(2);
  });

  it('deletes by key and by value', () => {
    const { cache } = setup(5);
    cache.set('a', 'x');
    cache.set('b', 'y');
    cache.set('c', 'x');
    cache.delete('b');
    cache.deleteWhere((value) => value === 'x');

    expect(cache.size).toBe(0);
  });

  it('shares a call in flight between its keys until it settles', async () => {
    const { cache } = setup();
    let finish: (value: string[]) => void = () => {};
    const call = new Promise<string[]>((resolve) => {
      finish = resolve;
    });

    cache.track(['a', 'b'], call);
    expect(cache.pending('a')).toBe(call);
    expect(cache.pending('b')).toBe(call);
    expect(cache.pending('c')).toBeUndefined();
    finish(['done']);
    await call;
    await Promise.resolve();

    expect(cache.pending('a')).toBeUndefined();
  });

  it('forgets a call that rejected, without an unhandled rejection', async () => {
    const { cache } = setup();
    const call = Promise.reject<string[]>(new Error('down'));

    cache.track(['a'], call);
    await expect(call).rejects.toThrow('down');
    await Promise.resolve();

    expect(cache.pending('a')).toBeUndefined();
  });

  it('clears calls in flight, and a cleared call settling does not clear its replacement', async () => {
    const { cache } = setup();
    let finishOld: (value: string[]) => void = () => {};
    const old = new Promise<string[]>((resolve) => {
      finishOld = resolve;
    });
    cache.track(['a'], old);
    cache.clearPending();
    const replacement = new Promise<string[]>(() => {});
    cache.track(['a'], replacement);

    finishOld([]);
    await old;
    await Promise.resolve();

    expect(cache.pending('a')).toBe(replacement);
  });
});

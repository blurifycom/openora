import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MockRngAdapter, hashSeed } from '../mock/mock-rng-adapter.js';

const draw = (rng: MockRngAdapter, count: number) =>
  Array.from({ length: count }, () => rng.nextFloat());

describe('hashSeed', () => {
  it('is deterministic', () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        expect(hashSeed(value)).toBe(hashSeed(value));
      }),
    );
  });

  it('always yields an unsigned 32-bit integer', () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        const hashed = hashSeed(value);
        expect(Number.isInteger(hashed)).toBe(true);
        expect(hashed).toBeGreaterThanOrEqual(0);
        expect(hashed).toBeLessThan(2 ** 32);
      }),
    );
  });

  it('gives the empty string the FNV offset basis', () => {
    expect(hashSeed('')).toBe(2166136261);
  });

  it.each([
    ['a', 'b'],
    ['seed-1', 'seed-2'],
    ['ab', 'ba'],
  ])('separates %j from %j', (left, right) => {
    expect(hashSeed(left)).not.toBe(hashSeed(right));
  });
});

describe('nextFloat', () => {
  it('stays inside [0, 1) for any seed', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (seed) => {
        for (const value of draw(new MockRngAdapter(seed), 200)) {
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThan(1);
        }
      }),
    );
  });

  it('replays the same sequence for the same seed', () => {
    expect(draw(new MockRngAdapter('replay'), 50)).toEqual(draw(new MockRngAdapter('replay'), 50));
  });

  it('gives different sequences for different seeds', () => {
    expect(draw(new MockRngAdapter('one'), 10)).not.toEqual(draw(new MockRngAdapter('two'), 10));
  });

  it('restarts the sequence when seed() is called again with the same value', () => {
    const rng = new MockRngAdapter('start');
    const first = draw(rng, 5);
    rng.seed('start');
    expect(draw(rng, 5)).toEqual(first);
  });

  it('seed() puts a running generator on the sequence of a fresh one built with that seed', () => {
    const rng = new MockRngAdapter('other');
    draw(rng, 3);
    rng.seed('target');
    expect(draw(rng, 5)).toEqual(draw(new MockRngAdapter('target'), 5));
  });

  it('does not repeat a value immediately', () => {
    const [first, second] = draw(new MockRngAdapter('x'), 2);
    expect(first).not.toBe(second);
  });
});

describe('nextInt', () => {
  it.each([
    [0, 1],
    [0, 2],
    [1, 7],
    [-5, 5],
    [-3, -1],
    [100, 101],
  ])('stays within [%i, %i) and reaches both ends', (min, maxExclusive) => {
    const rng = new MockRngAdapter(`bounds-${min}-${maxExclusive}`);
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i += 1) {
      const value = rng.nextInt(min, maxExclusive);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(min);
      expect(value).toBeLessThan(maxExclusive);
      seen.add(value);
    }
    expect(seen.has(min)).toBe(true);
    expect(seen.has(maxExclusive - 1)).toBe(true);
  });

  it('always returns min for a one-wide range', () => {
    const rng = new MockRngAdapter('one-wide');
    expect(Array.from({ length: 50 }, () => rng.nextInt(7, 8))).toEqual(Array(50).fill(7));
  });

  it.each([
    [5, 5],
    [5, 4],
    [0, -1],
    [0, 0],
  ])('rejects an empty or inverted range [%i, %i)', (min, maxExclusive) => {
    expect(() => new MockRngAdapter('s').nextInt(min, maxExclusive)).toThrow(/must be > min/);
  });

  it('stays within bounds for any seed and any range', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.integer({ min: -1000, max: 1000 }),
        fc.integer({ min: 1, max: 1000 }),
        (seed, min, width) => {
          const rng = new MockRngAdapter(seed);
          for (let i = 0; i < 20; i += 1) {
            const value = rng.nextInt(min, min + width);
            expect(value).toBeGreaterThanOrEqual(min);
            expect(value).toBeLessThan(min + width);
          }
        },
      ),
    );
  });
});

import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../canonical-json.js';

const hashOf = (text: string) => createHash('sha256').update(text).digest('hex');

describe('sha256Hex', () => {
  it('matches the golden hash of a nested value with sorted keys, a bigint and a dropped undefined', () => {
    expect(sha256Hex({ b: 1, a: [1, { d: undefined, c: 2n }] })).toBe(
      'a9c7bf3efba95abb6a833d2b0fda6e76aaf906a556628a49aa4e836b9502b537',
    );
  });

  it.each([
    ['undefined', undefined, 'null'],
    ['a function', () => 1, 'null'],
    ['null', null, 'null'],
    ['an empty object', {}, '{}'],
    ['a string', 'x', '"x"'],
    ['an array with holes of undefined', [undefined, 1], '[null,1]'],
    ['an object with a symbol member', { a: Symbol('s'), b: 1 }, '{"b":1}'],
    ['a unicode key', { é: 1, e: 2 }, '{"e":2,"é":1}'],
  ])('hashes %s as %s', (_name, value, canonical) => {
    expect(sha256Hex(value)).toBe(hashOf(canonical));
  });

  it('hashes a reference cycle as the string [Circular]', () => {
    const value: { self?: unknown } = {};
    value.self = value;
    expect(sha256Hex(value)).toBe(
      '8ab794bfaa96b50cbad2c517170b1065149d4eddb4e588fa7a7ff9044e9fbd46',
    );
  });

  it('hashes a shared reference that is not a cycle in full both times', () => {
    const shared = { x: 1 };
    expect(sha256Hex({ a: shared, b: shared })).toBe(hashOf('{"a":{"x":1},"b":{"x":1}}'));
  });

  it('stops at 64 levels of nesting without throwing', () => {
    let deep: unknown = 'leaf';
    for (let level = 0; level < 10_000; level += 1) {
      deep = [deep];
    }
    expect(sha256Hex(deep)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not depend on key insertion order', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (record) => {
        const reversed = Object.fromEntries(Object.entries(record).reverse());
        expect(sha256Hex(reversed)).toBe(sha256Hex(record));
      }),
    );
  });

  it('changes when any member value changes', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string(), fc.integer(), { minKeys: 1 }),
        fc.nat(),
        (record, pick) => {
          const keys = Object.keys(record);
          const key = keys[pick % keys.length] ?? '';
          const changed = { ...record, [key]: (record[key] ?? 0) + 1 };
          expect(sha256Hex(changed)).not.toBe(sha256Hex(record));
        },
      ),
    );
  });

  it('tells a string apart from the number it spells', () => {
    expect(sha256Hex({ amount: '10' })).not.toBe(sha256Hex({ amount: 10 }));
  });
});

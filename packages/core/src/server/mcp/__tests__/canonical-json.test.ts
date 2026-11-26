import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../canonical-json.js';

function sha(text: string) {
  return createHash('sha256').update(text).digest('hex');
}

function nest(depth: number) {
  let value: unknown = 'leaf';
  for (let i = 0; i < depth; i += 1) {
    value = [value];
  }
  return value;
}

describe('sha256Hex', () => {
  it('equal values with different key order produce the same hash', () => {
    expect(sha256Hex({ a: 1, b: 2 })).toBe(sha256Hex({ b: 2, a: 1 }));
    expect(sha256Hex({ a: 1, b: 2 })).toBe(sha('{"a":1,"b":2}'));
  });

  it('keys are sorted at every depth', () => {
    expect(sha256Hex({ z: { y: 1, x: [{ d: 1, c: 2 }] }, a: 0 })).toBe(
      sha('{"a":0,"z":{"x":[{"c":2,"d":1}],"y":1}}'),
    );
  });

  it('undefined members are dropped from objects and become null in arrays', () => {
    expect(sha256Hex({ a: undefined, b: 1 })).toBe(sha('{"b":1}'));
    expect(sha256Hex([1, undefined, 3])).toBe(sha('[1,null,3]'));
    expect(sha256Hex({ f: () => 1, s: Symbol('x'), b: 1 })).toBe(sha('{"b":1}'));
  });

  it('a bigint hashes as its decimal string', () => {
    expect(sha256Hex({ n: 12345678901234567890n })).toBe(sha('{"n":"12345678901234567890"}'));
    expect(sha256Hex(1n)).not.toBe(sha256Hex(1));
  });

  it('a reference cycle hashes as the circular marker without throwing', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic['self'] = cyclic;
    expect(sha256Hex(cyclic)).toBe(sha('{"a":1,"self":"[Circular]"}'));
  });

  it('a shared non-cyclic reference is not marked circular', () => {
    const shared = { v: 1 };
    expect(sha256Hex({ a: shared, b: shared })).toBe(sha('{"a":{"v":1},"b":{"v":1}}'));
  });

  it('values nested deeper than 64 levels hash as the too-deep marker', () => {
    const at64 = `${'['.repeat(64)}"leaf"${']'.repeat(64)}`;
    expect(sha256Hex(nest(64))).toBe(sha(at64));
    const tooDeep = `${'['.repeat(64)}"[TooDeep]"${']'.repeat(64)}`;
    expect(sha256Hex(nest(65))).toBe(sha(tooDeep));
    expect(sha256Hex(nest(65))).toBe(sha256Hex(nest(80)));
  });

  it('different values produce different hashes', () => {
    expect(sha256Hex({ a: 1 })).not.toBe(sha256Hex({ a: 2 }));
    expect(sha256Hex([1, 2])).not.toBe(sha256Hex([2, 1]));
    expect(sha256Hex('1')).not.toBe(sha256Hex(1));
    expect(sha256Hex(null)).not.toBe(sha256Hex('null'));
  });

  it('a top-level undefined hashes like null', () => {
    expect(sha256Hex(undefined)).toBe(sha256Hex(null));
    expect(sha256Hex(undefined)).toBe(sha('null'));
  });
});

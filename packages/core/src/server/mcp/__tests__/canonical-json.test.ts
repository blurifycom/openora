import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '../canonical-json.js';

describe('canonicalJson', () => {
  it('serializes equal objects to the same bytes whatever their key order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { f: 1, e: 2 }], c: 'x' } })).toBe(
      canonicalJson({ a: { c: 'x', d: [3, { e: 2, f: 1 }] }, b: 1 }),
    );
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('keeps array order and drops undefined members the way JSON does', () => {
    expect(canonicalJson({ list: [2, 1, undefined], skipped: undefined, kept: null })).toBe(
      '{"kept":null,"list":[2,1,null]}',
    );
  });

  it('serializes top-level undefined as null', () => {
    expect(canonicalJson(undefined)).toBe('null');
  });

  it('never throws on a bigint or a reference cycle', () => {
    const cyclic: Record<string, unknown> = { id: 1 };
    cyclic['self'] = cyclic;

    expect(canonicalJson({ amount: 10n })).toBe('{"amount":"10"}');
    expect(canonicalJson(cyclic)).toBe('{"id":1,"self":"[Circular]"}');
  });
});

describe('sha256Hex', () => {
  it('hashes the canonical JSON', () => {
    expect(sha256Hex({ b: 1, a: 2 })).toBe(
      createHash('sha256').update('{"a":2,"b":1}').digest('hex'),
    );
  });
});

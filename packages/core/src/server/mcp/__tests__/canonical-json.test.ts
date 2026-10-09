import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '../canonical-json.js';

const MAX_NESTING = 64;
const REQUEST_BODY_NESTING = 400_000;

function nestedArrays(levels: number): unknown {
  let value: unknown = 'leaf';
  for (let level = 0; level < levels; level += 1) {
    value = [value];
  }
  return value;
}

function nestedObjects(levels: number): unknown {
  let value: unknown = 'leaf';
  for (let level = 0; level < levels; level += 1) {
    value = { child: value };
  }
  return value;
}

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

  it('serializes a value nested 64 levels deep in full', () => {
    expect(canonicalJson(nestedArrays(MAX_NESTING))).toBe(
      `${'['.repeat(MAX_NESTING)}"leaf"${']'.repeat(MAX_NESTING)}`,
    );
  });

  it('serializes whatever nests deeper than 64 levels as a fixed marker', () => {
    expect(canonicalJson(nestedArrays(MAX_NESTING + 1))).toBe(
      `${'['.repeat(MAX_NESTING)}"[TooDeep]"${']'.repeat(MAX_NESTING)}`,
    );
    expect(canonicalJson(nestedObjects(MAX_NESTING + 1))).toBe(
      `${'{"child":'.repeat(MAX_NESTING)}"[TooDeep]"${'}'.repeat(MAX_NESTING)}`,
    );
  });

  it('never overflows the stack on a value nested as deep as a 1 MiB request body allows', () => {
    const deep = nestedArrays(REQUEST_BODY_NESTING);

    expect(canonicalJson(deep)).toBe(canonicalJson(nestedArrays(MAX_NESTING + 1)));
    expect(sha256Hex(deep)).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex(nestedObjects(REQUEST_BODY_NESTING))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('sha256Hex', () => {
  it('hashes the canonical JSON', () => {
    expect(sha256Hex({ b: 1, a: 2 })).toBe(
      createHash('sha256').update('{"a":2,"b":1}').digest('hex'),
    );
  });
});

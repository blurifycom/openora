import { describe, expect, it } from 'vitest';
import { createBoundedJsonParamsSchema, fitsJsonBytes } from '../schemas/bounded-json-params.js';

describe('fitsJsonBytes', () => {
  it('accepts a value of exactly the byte limit', () => {
    expect(JSON.stringify('aaa')).toHaveLength(5);
    expect(fitsJsonBytes('aaa', 5)).toBe(true);
  });

  it('refuses a value one byte over the limit', () => {
    expect(fitsJsonBytes('aaaa', 5)).toBe(false);
    expect(fitsJsonBytes({ a: 1 }, 6)).toBe(false);
    expect(fitsJsonBytes({ a: 1 }, 7)).toBe(true);
  });

  it('counts multi-byte characters as bytes not characters', () => {
    const value = '€€';
    expect(JSON.stringify(value)).toHaveLength(4);
    expect(fitsJsonBytes(value, 4)).toBe(false);
    expect(fitsJsonBytes(value, 8)).toBe(true);
    expect(fitsJsonBytes(value, 7)).toBe(false);
  });

  it('counts a surrogate pair as four bytes', () => {
    expect(fitsJsonBytes('😀', 6)).toBe(true);
    expect(fitsJsonBytes('😀', 5)).toBe(false);
  });

  it('counts a deeply nested value by its serialized size', () => {
    let nested: unknown = 1;
    for (let i = 0; i < 50; i++) {
      nested = { a: nested };
    }
    const size = new TextEncoder().encode(JSON.stringify(nested)).length;
    expect(fitsJsonBytes(nested, size)).toBe(true);
    expect(fitsJsonBytes(nested, size - 1)).toBe(false);
  });
});

describe('createBoundedJsonParamsSchema', () => {
  const schema = createBoundedJsonParamsSchema({ maxBytes: 20, label: 'Params' });

  it('accepts a record within the limit', () => {
    expect(schema.safeParse({ a: 'b' }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(true);
  });

  it('accepts a record of exactly the limit and refuses one byte over', () => {
    const exact = { k: 'x'.repeat(20 - '{"k":""}'.length) };
    expect(JSON.stringify(exact)).toHaveLength(20);
    expect(schema.safeParse(exact).success).toBe(true);
    expect(schema.safeParse({ k: `${exact.k}x` }).success).toBe(false);
  });

  it('refuses an empty key or a key over 64 characters', () => {
    const wide = createBoundedJsonParamsSchema({ maxBytes: 1000, label: 'Params' });
    expect(wide.safeParse({ '': 1 }).success).toBe(false);
    expect(wide.safeParse({ [`${'k'.repeat(64)}`]: 1 }).success).toBe(true);
    expect(wide.safeParse({ [`${'k'.repeat(65)}`]: 1 }).success).toBe(false);
  });

  it('refuses a record over the limit with the labelled message', () => {
    const result = schema.safeParse({ key: 'x'.repeat(50) });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.message)).toContain(
      'Params must serialize to at most 20 bytes',
    );
  });

  it('refuses a nested record just over the limit', () => {
    const exact = { a: { b: { c: 'x'.repeat(20 - '{"a":{"b":{"c":""}}}'.length) } } };
    expect(JSON.stringify(exact)).toHaveLength(20);
    expect(schema.safeParse(exact).success).toBe(true);
    expect(schema.safeParse({ a: { b: { c: `${exact.a.b.c}x` } } }).success).toBe(false);
  });

  it('refuses a value that is not JSON', () => {
    const wide = createBoundedJsonParamsSchema({ maxBytes: 1000, label: 'Params' });
    expect(wide.safeParse({ a: undefined }).success).toBe(false);
    expect(wide.safeParse({ a: () => 1 }).success).toBe(false);
    expect(wide.safeParse({ a: 10n }).success).toBe(false);
    expect(wide.safeParse({ a: new Date() }).success).toBe(false);
    expect(wide.safeParse('text').success).toBe(false);
    expect(wide.safeParse([1]).success).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { findOneOrThrow, pageToOffset } from '../query-helpers.js';

describe('findOneOrThrow', () => {
  it('returns the first row when present', () => {
    expect(findOneOrThrow([{ id: '1' }, { id: '2' }], new Error('nope'))).toEqual({ id: '1' });
  });

  it('throws the provided error on an empty array', () => {
    const err = new Error('not found');
    expect(() => findOneOrThrow([], err)).toThrow(err);
  });
});

describe('pageToOffset', () => {
  it('converts a 1-based page + limit to an offset', () => {
    expect(pageToOffset(1, 20)).toBe(0);
    expect(pageToOffset(3, 20)).toBe(40);
  });
});

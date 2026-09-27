import { describe, expect, it } from 'vitest';
import { uuidPrefixRange } from '../admin-reporting.js';

describe('uuidPrefixRange', () => {
  it('spans every uuid that starts with a short prefix', () => {
    expect(uuidPrefixRange('A0DB')).toEqual({
      from: 'a0db0000-0000-0000-0000-000000000000',
      to: 'a0dbffff-ffff-ffff-ffff-ffffffffffff',
    });
  });

  it('ignores dashes so a prefix copied across a separator still matches', () => {
    expect(uuidPrefixRange('a0db9dda-e6')).toEqual({
      from: 'a0db9dda-e600-0000-0000-000000000000',
      to: 'a0db9dda-e6ff-ffff-ffff-ffffffffffff',
    });
  });

  it('collapses a full uuid to itself', () => {
    const id = 'a0db9dda-e602-4983-a37b-5d0ed2093bf4';
    expect(uuidPrefixRange(id)).toEqual({ from: id, to: id });
  });

  it('rejects input that cannot start a uuid', () => {
    expect(uuidPrefixRange('0xabc')).toBeNull();
    expect(uuidPrefixRange('a'.repeat(33))).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { normalizeCountryCode } from '../geo-ip.js';

describe('normalizeCountryCode', () => {
  it('trims and uppercases valid country codes', () => {
    expect(normalizeCountryCode(' us ')).toBe('US');
  });

  it('returns null for invalid adapter values', () => {
    expect(normalizeCountryCode('USA')).toBeNull();
    expect(normalizeCountryCode(null)).toBeNull();
    expect(normalizeCountryCode(42)).toBeNull();
  });
});

import { describe, it, expect } from 'vitest';
import { MoneyAmountSchema, TimezoneSchema, resolveTimezone } from '../common.js';

describe('MoneyAmountSchema', () => {
  it('round-trips a 1-wei ETH amount (18-decimal precision)', () => {
    expect(MoneyAmountSchema.parse('0.000000000000000001')).toBe('0.000000000000000001');
    expect(MoneyAmountSchema.parse('21000000.123456789012345678')).toBe(
      '21000000.123456789012345678',
    );
  });

  it('round-trips an 8-decimal-place crypto amount (BTC-level precision)', () => {
    expect(MoneyAmountSchema.parse('0.00000001')).toBe('0.00000001');
  });

  it('still accepts a plain 2-decimal fiat amount', () => {
    expect(MoneyAmountSchema.parse('19.99')).toBe('19.99');
    expect(MoneyAmountSchema.parse('0')).toBe('0');
  });

  it('rejects amounts outside numeric(38, 18)', () => {
    expect(MoneyAmountSchema.safeParse('0.0000000000000000001').success).toBe(false);
    expect(MoneyAmountSchema.safeParse('100000000000000000000').success).toBe(false);
    expect(MoneyAmountSchema.safeParse('-1').success).toBe(false);
  });
});

describe('resolveTimezone', () => {
  it('canonicalises the aliases and casings different browsers report', () => {
    expect(resolveTimezone('europe/warsaw')).toBe('Europe/Warsaw');
    expect(resolveTimezone('US/Pacific')).toBe('America/Los_Angeles');
  });

  it('rejects a value the tz database does not recognise rather than passing it through', () => {
    expect(resolveTimezone('Mars/Phobos')).toBeNull();
    expect(resolveTimezone('')).toBeNull();
    expect(resolveTimezone('Europe/Warsaw ')).toBeNull();
    expect(resolveTimezone("'; DROP TABLE player;--")).toBeNull();
  });

  it('rejects a bare UTC offset, which Intl accepts but which is not a zone', () => {
    expect(resolveTimezone('+05:00')).toBeNull();
    expect(resolveTimezone('-08:00')).toBeNull();
  });
});

describe('TimezoneSchema', () => {
  it('accepts an empty string, leaving the drop to resolveTimezone', () => {
    expect(TimezoneSchema.safeParse('').success).toBe(true);
  });

  it('accepts arbitrary client text, leaving the drop to resolveTimezone', () => {
    expect(TimezoneSchema.safeParse('x'.repeat(65)).success).toBe(true);
    expect(resolveTimezone('x'.repeat(65))).toBeNull();
  });
});

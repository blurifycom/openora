import { describe, it, expect } from 'vitest';
import { MoneyAmountSchema, resolveTimezone } from '../common.js';

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
  it('accepts an IANA zone the browser reports and returns it unchanged', () => {
    expect(resolveTimezone('Europe/Warsaw')).toBe('Europe/Warsaw');
    expect(resolveTimezone('America/New_York')).toBe('America/New_York');
    expect(resolveTimezone('UTC')).toBe('UTC');
  });

  it('canonicalises the aliases and casings different browsers report', () => {
    // Two spellings of one zone must compare equal, or a returning session would look
    // like a move and churn `timezoneUpdatedAt`.
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
    // An offset is one moment's arithmetic: it goes wrong the next time DST moves.
    expect(resolveTimezone('+05:00')).toBeNull();
    expect(resolveTimezone('-08:00')).toBeNull();
  });
});

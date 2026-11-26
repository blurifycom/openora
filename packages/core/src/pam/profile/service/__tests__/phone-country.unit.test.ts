import { describe, expect, it } from 'vitest';
import { phoneMatchesCountryCallingCode } from '../phone-country.js';

describe('phoneMatchesCountryCallingCode', () => {
  it.each([
    ['+447911123456', 'GB'],
    ['+447911123456', 'GG'],
    ['+447911123456', 'JE'],
    ['+447911123456', 'IM'],
    ['+14155552671', 'US'],
    ['+14155552671', 'CA'],
    ['+380501234567', 'UA'],
    ['+48501234567', 'PL'],
  ])('accepts %s for %s', (phone, country) => {
    expect(phoneMatchesCountryCallingCode(phone, country)).toBe(true);
  });

  it.each([
    ['+447911123456', 'US'],
    ['+14155552671', 'GB'],
    ['+380501234567', 'PL'],
    ['+48501234567', 'UA'],
  ])('rejects %s for %s', (phone, country) => {
    expect(phoneMatchesCountryCallingCode(phone, country)).toBe(false);
  });

  it.each(['XX', 'ZZ', '', 'gb', 'GBR', '44'])('rejects an unresolvable country %j', (country) => {
    expect(phoneMatchesCountryCallingCode('+447911123456', country)).toBe(false);
  });

  it.each(['', 'garbage', '+', '+0', '+999999999999999999', '447911123456', '++447911123456'])(
    'rejects the unparseable phone %j',
    (phone) => {
      expect(phoneMatchesCountryCallingCode(phone, 'GB')).toBe(false);
    },
  );

  it('does not throw on any input pair', () => {
    expect(() => phoneMatchesCountryCallingCode('\u0000', '\u0000')).not.toThrow();
  });
});

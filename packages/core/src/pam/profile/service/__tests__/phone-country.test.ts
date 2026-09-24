import { describe, expect, it } from 'vitest';
import { phoneMatchesCountryCallingCode } from '../phone-country.js';

describe('phoneMatchesCountryCallingCode', () => {
  it('matches when the phone calling code equals the country calling code', () => {
    expect(phoneMatchesCountryCallingCode('+441632960001', 'GB')).toBe(true);
  });

  it('matches a territory that shares its calling code with another country', () => {
    expect(phoneMatchesCountryCallingCode('+12025550123', 'CA')).toBe(true);
  });

  it('matches Guernsey/Jersey/Isle of Man numbers against GB, all sharing +44', () => {
    expect(phoneMatchesCountryCallingCode('+441632960001', 'GG')).toBe(true);
    expect(phoneMatchesCountryCallingCode('+441632960001', 'JE')).toBe(true);
    expect(phoneMatchesCountryCallingCode('+441632960001', 'IM')).toBe(true);
  });

  it('rejects a phone calling code that does not match the country', () => {
    expect(phoneMatchesCountryCallingCode('+14155552671', 'GB')).toBe(false);
    expect(phoneMatchesCountryCallingCode('+441632960001', 'US')).toBe(false);
  });

  it('rejects an ISO-shaped country with no known calling-code metadata', () => {
    expect(phoneMatchesCountryCallingCode('+14155552671', 'ZZ')).toBe(false);
  });

  it('rejects an E.164-shaped phone with no known calling-code metadata', () => {
    expect(phoneMatchesCountryCallingCode('+99912345678', 'US')).toBe(false);
  });
});

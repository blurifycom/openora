import {
  getCountryCallingCode,
  parsePhoneNumberFromString,
  type CountryCode,
} from 'libphonenumber-js';

/**
 * Cross-validates a self-declared phone against a self-declared country by calling code, not
 * by exact-country match: territories can share a calling code (GB/GG/JE/IM all under +44,
 * US/CA under +1), so requiring the phone's detected country to equal the profile country
 * would reject legitimate combinations libphonenumber-js itself cannot tell apart from the
 * number alone.
 *
 * Returns `true` (no block) when either side can't be resolved - an unrecognised phone shape,
 * or a country code libphonenumber-js has no calling-code metadata for - because that is a
 * validation gap, not evidence of a mismatch, and this check must never make `country` a
 * hard requirement.
 */
export function phoneMatchesCountryCallingCode(phone: string, country: string): boolean {
  let expectedCallingCode: string;
  try {
    expectedCallingCode = getCountryCallingCode(country as CountryCode);
  } catch {
    return true;
  }

  const parsed = parsePhoneNumberFromString(phone);
  if (!parsed) {
    return true;
  }

  return parsed.countryCallingCode === expectedCallingCode;
}

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
 * When both values are supplied, each must resolve to calling-code metadata. The profile
 * contract deliberately permits any ISO-shaped country and E.164-shaped phone, but a pair
 * that this library cannot resolve has not passed the stronger cross-field validation.
 */
export function phoneMatchesCountryCallingCode(phone: string, country: string): boolean {
  let expectedCallingCode: string;
  try {
    expectedCallingCode = getCountryCallingCode(country as CountryCode);
  } catch {
    return false;
  }

  const parsed = parsePhoneNumberFromString(phone);
  if (!parsed) {
    return false;
  }

  return parsed.countryCallingCode === expectedCallingCode;
}

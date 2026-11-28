import {
  getCountryCallingCode,
  parsePhoneNumberFromString,
  type CountryCode,
} from 'libphonenumber-js';

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

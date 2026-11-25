import { describe, it } from 'vitest';

describe('validateBannerImageUrl', () => {
  it.todo('accepts an https URL on an allowed host');
  it.todo('accepts a subdomain of an allowed host only when the host rule allows it');
  it.todo('refuses a string that is not a URL');
  it.todo('refuses http and other protocols');
  it.todo('refuses a host that is not allowed');
  it.todo('refuses everything when the allowed host list is empty');
});

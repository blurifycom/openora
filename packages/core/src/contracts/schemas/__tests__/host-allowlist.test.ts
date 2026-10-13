import { describe, expect, it } from 'vitest';
import { isAllowedHttpsUrl } from '../host-allowlist.js';

const HOSTS = ['avatars.example.test'];

describe('isAllowedHttpsUrl', () => {
  it('accepts an https URL on an allowed host or one of its subdomains', () => {
    expect(isAllowedHttpsUrl('https://avatars.example.test/a.png', HOSTS)).toBe(true);
    expect(isAllowedHttpsUrl('https://AVATARS.example.test/a.png', HOSTS)).toBe(true);
    expect(isAllowedHttpsUrl('https://eu.avatars.example.test/a.png', HOSTS)).toBe(true);
  });

  it('rejects a foreign host, a lookalike suffix and the allowed host as a path or userinfo', () => {
    expect(isAllowedHttpsUrl('https://tracker.example/a.png', HOSTS)).toBe(false);
    expect(isAllowedHttpsUrl('https://evilavatars.example.test/a.png', HOSTS)).toBe(false);
    expect(isAllowedHttpsUrl('https://tracker.example/avatars.example.test', HOSTS)).toBe(false);
    expect(isAllowedHttpsUrl('https://avatars.example.test@tracker.example/a.png', HOSTS)).toBe(
      false,
    );
  });

  it('rejects a non-https scheme and an unparseable URL', () => {
    expect(isAllowedHttpsUrl('http://avatars.example.test/a.png', HOSTS)).toBe(false);
    expect(isAllowedHttpsUrl('javascript:alert(1)', HOSTS)).toBe(false);
    expect(isAllowedHttpsUrl('avatars.example.test/a.png', HOSTS)).toBe(false);
  });

  it('rejects every URL when the allowlist is empty', () => {
    expect(isAllowedHttpsUrl('https://avatars.example.test/a.png', [])).toBe(false);
  });
});

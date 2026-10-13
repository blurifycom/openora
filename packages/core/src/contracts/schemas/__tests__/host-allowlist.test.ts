import { describe, expect, it } from 'vitest';
import {
  UrlPrefixAllowlistEntrySchema,
  isAllowedHttpsUrl,
  isAllowedUrlPrefix,
} from '../host-allowlist.js';

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

  it('rejects a non-default port on an allowed host', () => {
    expect(isAllowedHttpsUrl('https://avatars.example.test:8443/a.png', HOSTS)).toBe(false);
    expect(isAllowedHttpsUrl('https://avatars.example.test:443/a.png', HOSTS)).toBe(true);
  });

  it('rejects every URL when the allowlist is empty', () => {
    expect(isAllowedHttpsUrl('https://avatars.example.test/a.png', [])).toBe(false);
  });
});

const PREFIXES = ['https://play.example.test/avatars/', 'http://localhost:3000/avatars/'];

describe('isAllowedUrlPrefix', () => {
  it('accepts a URL under an allowed prefix, http included when the prefix is http', () => {
    expect(isAllowedUrlPrefix('https://play.example.test/avatars/gold-1.png', PREFIXES)).toBe(true);
    expect(isAllowedUrlPrefix('http://localhost:3000/avatars/gold-1.png', PREFIXES)).toBe(true);
    expect(isAllowedUrlPrefix('https://PLAY.example.test:443/avatars/gold-1.png', PREFIXES)).toBe(
      true,
    );
  });

  it('rejects another path, scheme, port or subdomain of the prefix origin', () => {
    expect(isAllowedUrlPrefix('https://play.example.test/api/me.png', PREFIXES)).toBe(false);
    expect(isAllowedUrlPrefix('https://play.example.test/avatars', PREFIXES)).toBe(false);
    expect(isAllowedUrlPrefix('https://play.example.test/avatarsx/a.png', PREFIXES)).toBe(false);
    expect(isAllowedUrlPrefix('http://play.example.test/avatars/gold-1.png', PREFIXES)).toBe(false);
    expect(isAllowedUrlPrefix('http://localhost:3001/avatars/gold-1.png', PREFIXES)).toBe(false);
    expect(isAllowedUrlPrefix('https://cdn.play.example.test/avatars/gold-1.png', PREFIXES)).toBe(
      false,
    );
    expect(isAllowedUrlPrefix('https://play.example.test.evil/avatars/a.png', PREFIXES)).toBe(
      false,
    );
  });

  it('rejects a path that escapes the prefix', () => {
    expect(isAllowedUrlPrefix('https://play.example.test/avatars/../api/a.png', PREFIXES)).toBe(
      false,
    );
    expect(isAllowedUrlPrefix('https://play.example.test/avatars/%2e%2e/api/a.png', PREFIXES)).toBe(
      false,
    );
    expect(isAllowedUrlPrefix('https://play.example.test/avatars/%2E%2E/api/a.png', PREFIXES)).toBe(
      false,
    );
    expect(isAllowedUrlPrefix('https://play.example.test/avatars\\..\\api/a.png', PREFIXES)).toBe(
      false,
    );
    expect(isAllowedUrlPrefix('https://play.example.test/avatars/..%2fapi/a.png', PREFIXES)).toBe(
      false,
    );
    expect(isAllowedUrlPrefix('https://play.example.test/avatars/..%5Capi/a.png', PREFIXES)).toBe(
      false,
    );
  });

  it('rejects a query, a hash or userinfo instead of stripping it', () => {
    expect(isAllowedUrlPrefix('https://play.example.test/avatars/a.png?id=42', PREFIXES)).toBe(
      false,
    );
    expect(isAllowedUrlPrefix('https://play.example.test/avatars/a.png?', PREFIXES)).toBe(false);
    expect(isAllowedUrlPrefix('https://play.example.test/avatars/a.png#x', PREFIXES)).toBe(false);
    expect(isAllowedUrlPrefix('https://u:p@play.example.test/avatars/a.png', PREFIXES)).toBe(false);
    expect(
      isAllowedUrlPrefix('https://play.example.test@tracker.example/avatars/a.png', PREFIXES),
    ).toBe(false);
  });

  it('rejects an unparseable URL, a non-http scheme and an empty allowlist', () => {
    expect(isAllowedUrlPrefix('/avatars/gold-1.png', PREFIXES)).toBe(false);
    expect(isAllowedUrlPrefix('javascript:alert(1)', PREFIXES)).toBe(false);
    expect(isAllowedUrlPrefix('https://play.example.test/avatars/gold-1.png', [])).toBe(false);
  });
});

describe('UrlPrefixAllowlistEntrySchema', () => {
  it('canonicalizes an absolute http(s) URL whose path ends in a slash', () => {
    expect(UrlPrefixAllowlistEntrySchema.parse(' https://PLAY.example.test/avatars/ ')).toBe(
      'https://play.example.test/avatars/',
    );
    expect(UrlPrefixAllowlistEntrySchema.parse('http://localhost:3000/avatars/')).toBe(
      'http://localhost:3000/avatars/',
    );
  });

  it('rejects a relative path, another scheme, a missing slash, a query, a hash or userinfo', () => {
    for (const entry of [
      '/avatars/',
      'play.example.test/avatars/',
      'ftp://play.example.test/avatars/',
      'https://play.example.test/avatars',
      'https://play.example.test/avatars/?v=1',
      'https://play.example.test/avatars/#x',
      'https://u:p@play.example.test/avatars/',
    ]) {
      expect(UrlPrefixAllowlistEntrySchema.safeParse(entry).success).toBe(false);
    }
  });
});

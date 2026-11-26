import { describe, expect, it } from 'vitest';
import { BannerLinkUrlSchema } from '../index.js';

const accepts = (value: string) => BannerLinkUrlSchema.safeParse(value).success;

describe('BannerLinkUrlSchema', () => {
  it.each([
    '/',
    '/promotions',
    '/casino/games?tag=new#top',
    '/%2f%2fevil.test',
    '/%2e%2e/admin',
    'https://partner.example.test/offer',
    'http://partner.example.test/offer',
    'HTTPS://partner.example.test',
  ])('accepts %j', (value) => {
    expect(accepts(value)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['protocol-relative', '//evil.test'],
    ['slash backslash', '/\\evil.test'],
    ['triple slash', '///evil.test'],
    ['backslash first', '\\\\evil.test'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['mixed case javascript scheme', 'JaVaScRiPt:alert(1)'],
    ['javascript with a tab in the scheme', 'java\tscript:alert(1)'],
    ['javascript after leading whitespace', ' javascript:alert(1)'],
    ['data scheme', 'data:text/html,<script>alert(1)</script>'],
    ['vbscript scheme', 'vbscript:msgbox(1)'],
    ['relative path without a slash', 'promotions'],
    ['scheme-less host', 'evil.test/promo'],
    ['ftp scheme', 'ftp://evil.test'],
  ])('rejects %s', (_name, value) => {
    expect(accepts(value)).toBe(false);
  });

  it.each([
    ['tab between the slashes', '/\t/evil.test'],
    ['newline between the slashes', '/\n/evil.test'],
    ['carriage return between the slashes', '/\r/evil.test'],
  ])('rejects an internal path a browser reads as protocol-relative: %s', (_name, value) => {
    expect(new URL(value, 'https://casino.example.test').host).toBe('evil.test');
    expect(accepts(value)).toBe(false);
  });
});

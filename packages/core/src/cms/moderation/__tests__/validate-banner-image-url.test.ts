import { describe, expect, it } from 'vitest';
import { validateBannerImageUrl } from '../validate-banner-image-url.js';

const hosts = ['cdn.example.com'];

describe('validateBannerImageUrl', () => {
  it('accepts an https URL on an allowed host', () => {
    expect(validateBannerImageUrl('https://cdn.example.com/a/b.png?x=1', hosts)).toEqual({
      ok: true,
    });
  });

  it('accepts a subdomain of an allowed host only when the host rule allows it', () => {
    expect(validateBannerImageUrl('https://eu.cdn.example.com/b.png', hosts)).toEqual({ ok: true });
    expect(validateBannerImageUrl('https://evilcdn.example.com/b.png', hosts).ok).toBe(false);
    expect(validateBannerImageUrl('https://cdn.example.com.evil.test/b.png', hosts).ok).toBe(false);
    expect(validateBannerImageUrl('https://example.com/b.png', hosts).ok).toBe(false);
  });

  it('refuses a string that is not a URL', () => {
    for (const value of ['', 'not a url', '/relative/banner.png', '//cdn.example.com/b.png']) {
      expect(validateBannerImageUrl(value, hosts).ok).toBe(false);
    }
  });

  it('refuses http and other protocols', () => {
    for (const value of [
      'http://cdn.example.com/b.png',
      'ftp://cdn.example.com/b.png',
      'javascript:alert(1)//cdn.example.com',
      'data:image/png;base64,AAAA',
    ]) {
      expect(validateBannerImageUrl(value, hosts).ok).toBe(false);
    }
  });

  it('refuses a host that is not allowed', () => {
    const result = validateBannerImageUrl('https://other.test/b.png', hosts);
    expect(result).toEqual({ ok: false, reason: 'host not allowed: other.test' });
    expect(validateBannerImageUrl('https://cdn.example.com@evil.test/b.png', hosts).ok).toBe(false);
    expect(validateBannerImageUrl('https://evil.test\\@cdn.example.com/b.png', hosts).ok).toBe(
      false,
    );
    expect(validateBannerImageUrl('https://evil.test/?h=cdn.example.com', hosts).ok).toBe(false);
  });

  it('refuses everything when the allowed host list is empty', () => {
    expect(validateBannerImageUrl('https://cdn.example.com/b.png', [])).toEqual({
      ok: false,
      reason: 'host not allowed: cdn.example.com',
    });
  });
});

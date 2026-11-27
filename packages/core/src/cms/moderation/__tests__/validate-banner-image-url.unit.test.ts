import { describe, expect, it } from 'vitest';
import { validateBannerImageUrl } from '../validate-banner-image-url.js';

const ALLOWED = ['cdn.example.test'];

describe('validateBannerImageUrl', () => {
  it.each([
    'https://cdn.example.test/banner.png',
    'https://img.cdn.example.test/banner.png',
    'HTTPS://CDN.EXAMPLE.TEST/banner.png',
    '  https://cdn.example.test/banner.png  ',
    'https://cdn%2Eexample%2Etest/banner.png',
  ])('accepts %j', (url) => {
    expect(validateBannerImageUrl(url, ALLOWED)).toEqual({ ok: true });
  });

  it.each([
    ['plain http', 'http://cdn.example.test/banner.png'],
    ['javascript scheme', 'javascript:alert(1)//cdn.example.test'],
    ['data scheme', 'data:image/png;base64,iVBORw0KGgo='],
    ['protocol-relative', '//cdn.example.test/banner.png'],
    ['relative path', '/banner.png'],
    ['userinfo pointing at another host', 'https://cdn.example.test@evil.test/banner.png'],
    ['allowed host as a path', 'https://evil.test/cdn.example.test/banner.png'],
    ['allowed host as a prefix', 'https://cdn.example.test.evil.test/banner.png'],
    ['allowed host as a suffix without a dot', 'https://evilcdn.example.test/banner.png'],
    ['backslash authority', 'https:\\\\evil.test\\cdn.example.test'],
    ['percent-encoded dot to another host', 'https://cdn.example.test%2eevil.test/banner.png'],
    ['trailing dot host', 'https://cdn.example.test./banner.png'],
    ['empty string', ''],
    ['not a url', 'banner.png'],
  ])('rejects %s', (_name, url) => {
    expect(validateBannerImageUrl(url, ALLOWED).ok).toBe(false);
  });

  it('rejects every host when the allowlist is empty', () => {
    expect(validateBannerImageUrl('https://cdn.example.test/a.png', []).ok).toBe(false);
  });

  it('names the protocol it refused', () => {
    expect(validateBannerImageUrl('ftp://cdn.example.test/a.png', ALLOWED)).toEqual({
      ok: false,
      reason: 'unsupported protocol: ftp:',
    });
  });

  it('names the host it refused', () => {
    expect(validateBannerImageUrl('https://evil.test/a.png', ALLOWED)).toEqual({
      ok: false,
      reason: 'host not allowed: evil.test',
    });
  });
});

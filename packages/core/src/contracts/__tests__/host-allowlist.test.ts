import { describe, expect, it } from 'vitest';
import { isAllowedHost, isAllowedHttpsUrl, isAllowedUrlPrefix } from '../schemas/host-allowlist.js';

const hosts = ['cdn.example.com'];

describe('isAllowedHost', () => {
  it('accepts a listed host and its subdomains', () => {
    expect(isAllowedHost('cdn.example.com', hosts)).toBe(true);
    expect(isAllowedHost('a.b.cdn.example.com', hosts)).toBe(true);
  });

  it('accepts a listed host regardless of case through a url', () => {
    expect(isAllowedHttpsUrl('https://CDN.Example.COM/x.png', hosts)).toBe(true);
  });

  it.todo('GAP: accepts a listed host regardless of case');

  it('refuses an unlisted host and a lookalike suffix', () => {
    expect(isAllowedHost('example.com', hosts)).toBe(false);
    expect(isAllowedHost('evilcdn.example.com', hosts)).toBe(false);
    expect(isAllowedHost('cdn.example.com.evil.com', hosts)).toBe(false);
    expect(isAllowedHost('xcdn.example.com', hosts)).toBe(false);
    expect(isAllowedHost('cdn-example.com', hosts)).toBe(false);
  });

  it('refuses a trailing-dot host', () => {
    expect(isAllowedHost('cdn.example.com.', hosts)).toBe(false);
  });

  it('refuses everything with an empty allow-list', () => {
    expect(isAllowedHost('cdn.example.com', [])).toBe(false);
    expect(isAllowedHost('', [])).toBe(false);
  });
});

describe('isAllowedHttpsUrl', () => {
  it('accepts an https url on a listed host', () => {
    expect(isAllowedHttpsUrl('https://cdn.example.com/a.png', hosts)).toBe(true);
    expect(isAllowedHttpsUrl('https://img.cdn.example.com/a.png?x=1#y', hosts)).toBe(true);
    expect(isAllowedHttpsUrl('https://cdn.example.com:443/a.png', hosts)).toBe(true);
  });

  it('refuses http and non-http schemes', () => {
    expect(isAllowedHttpsUrl('http://cdn.example.com/a.png', hosts)).toBe(false);
    expect(isAllowedHttpsUrl('ftp://cdn.example.com/a.png', hosts)).toBe(false);
    expect(isAllowedHttpsUrl('javascript://cdn.example.com/%0Aalert(1)', hosts)).toBe(false);
    expect(isAllowedHttpsUrl('data:text/html,cdn.example.com', hosts)).toBe(false);
  });

  it('refuses an unparseable url', () => {
    expect(isAllowedHttpsUrl('not a url', hosts)).toBe(false);
    expect(isAllowedHttpsUrl('', hosts)).toBe(false);
    expect(isAllowedHttpsUrl('//cdn.example.com/a.png', hosts)).toBe(false);
  });

  it('refuses a non-default port', () => {
    expect(isAllowedHttpsUrl('https://cdn.example.com:8443/a.png', hosts)).toBe(false);
  });

  it('refuses a lookalike host and a trailing-dot host', () => {
    expect(isAllowedHttpsUrl('https://cdn.example.com.evil.com/a.png', hosts)).toBe(false);
    expect(isAllowedHttpsUrl('https://evil.com/?h=cdn.example.com', hosts)).toBe(false);
    expect(isAllowedHttpsUrl('https://cdn.example.com./a.png', hosts)).toBe(false);
  });

  it('refuses a userinfo host confusion', () => {
    expect(isAllowedHttpsUrl('https://cdn.example.com@evil.com/a.png', hosts)).toBe(false);
    expect(isAllowedHttpsUrl('https://cdn.example.com:pw@evil.com/a.png', hosts)).toBe(false);
  });

  it.todo('BUG: refuses a url with credentials');
});

describe('isAllowedUrlPrefix', () => {
  const prefixes = ['https://cdn.example.com/media/'];

  it('accepts a url under a listed prefix', () => {
    expect(isAllowedUrlPrefix('https://cdn.example.com/media/a.png', prefixes)).toBe(true);
    expect(isAllowedUrlPrefix('https://cdn.example.com/media/x/y/a.png', prefixes)).toBe(true);
    expect(isAllowedUrlPrefix('https://CDN.example.com/media/a.png', prefixes)).toBe(true);
  });

  it('refuses a url that only shares a string prefix with a different path segment', () => {
    expect(isAllowedUrlPrefix('https://cdn.example.com/media-evil/a.png', prefixes)).toBe(false);
    expect(isAllowedUrlPrefix('https://cdn.example.com/media', prefixes)).toBe(false);
  });

  it('refuses a url with a different origin', () => {
    expect(isAllowedUrlPrefix('http://cdn.example.com/media/a.png', prefixes)).toBe(false);
    expect(isAllowedUrlPrefix('https://cdn.example.com:8443/media/a.png', prefixes)).toBe(false);
    expect(isAllowedUrlPrefix('https://evil.com/media/a.png', prefixes)).toBe(false);
    expect(isAllowedUrlPrefix('https://cdn.example.com.evil.com/media/a.png', prefixes)).toBe(
      false,
    );
  });

  it('refuses credentials, query, fragment and non-http schemes', () => {
    expect(isAllowedUrlPrefix('https://u:p@cdn.example.com/media/a.png', prefixes)).toBe(false);
    expect(isAllowedUrlPrefix('https://cdn.example.com/media/a.png?x=1', prefixes)).toBe(false);
    expect(isAllowedUrlPrefix('https://cdn.example.com/media/a.png#x', prefixes)).toBe(false);
    expect(isAllowedUrlPrefix('ftp://cdn.example.com/media/a.png', prefixes)).toBe(false);
  });

  it('refuses dot-segment and encoded-separator traversal out of the prefix', () => {
    expect(isAllowedUrlPrefix('https://cdn.example.com/media/../secret', prefixes)).toBe(false);
    expect(isAllowedUrlPrefix('https://cdn.example.com/media/%2e%2e/secret', prefixes)).toBe(false);
    expect(isAllowedUrlPrefix('https://cdn.example.com/media/a%2fb.png', prefixes)).toBe(false);
    expect(isAllowedUrlPrefix('https://cdn.example.com/media/a%5Cb.png', prefixes)).toBe(false);
  });

  it('refuses everything with an empty list', () => {
    expect(isAllowedUrlPrefix('https://cdn.example.com/media/a.png', [])).toBe(false);
  });
});

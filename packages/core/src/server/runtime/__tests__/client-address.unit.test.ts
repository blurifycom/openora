import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  applyClientAddress,
  clientFromForwardedFor,
  normalizeAddress,
  parseTrustedProxies,
  resolveTrustedProxies,
} from '../client-address.js';

const proxies = parseTrustedProxies(['10.0.0.0/8', '2001:db8::/32', '192.168.1.5']);

describe('normalizeAddress', () => {
  it.each([
    ['::ffff:1.2.3.4', '1.2.3.4'],
    ['::ffff:127.0.0.1', '127.0.0.1'],
    ['1.2.3.4', '1.2.3.4'],
    ['::ffff:nope', '::ffff:nope'],
    ['::ffff:999.1.1.1', '::ffff:999.1.1.1'],
    ['::ffff:2001:db8::1', '::ffff:2001:db8::1'],
    ['2001:db8::1', '2001:db8::1'],
    ['::1', '::1'],
    ['', ''],
    ['abcdefg1.2.3.4', 'abcdefg1.2.3.4'],
  ])('%j becomes %j', (input, expected) => {
    expect(normalizeAddress(input)).toBe(expected);
  });

  it('is idempotent', () => {
    fc.assert(
      fc.property(fc.ipV4(), (ip) => {
        const mapped = `::ffff:${ip}`;
        expect(normalizeAddress(normalizeAddress(mapped))).toBe(normalizeAddress(mapped));
      }),
    );
  });
});

describe('parseTrustedProxies', () => {
  it.each([
    ['10.1.2.3', true],
    ['10.255.255.255', true],
    ['11.0.0.0', false],
    ['9.255.255.255', false],
    ['192.168.1.5', true],
    ['192.168.1.4', false],
    ['192.168.1.6', false],
    ['2001:db8::1', true],
    ['2001:db8:ffff::1', true],
    ['2001:db9::1', false],
    ['::ffff:10.1.2.3', true],
    ['::ffff:11.1.2.3', false],
    ['not-an-ip', false],
    ['', false],
    ['10.0.0.1:80', false],
  ])('contains(%j) is %s', (address, expected) => {
    expect(proxies.contains(address)).toBe(expected);
  });

  it.each([
    ['/32 matches only the address', ['1.2.3.4/32'], '1.2.3.4', true],
    ['/32 excludes the neighbour', ['1.2.3.4/32'], '1.2.3.5', false],
    ['/31 covers two addresses', ['1.2.3.4/31'], '1.2.3.5', true],
    ['/31 excludes the next pair', ['1.2.3.4/31'], '1.2.3.6', false],
    ['/0 matches every IPv4', ['0.0.0.0/0'], '8.8.8.8', true],
    ['/128 matches only the address', ['::1/128'], '::1', true],
    ['/128 excludes the neighbour', ['::1/128'], '::2', false],
    ['an IPv4 list never matches an IPv6 peer', ['0.0.0.0/0'], '2001:db8::1', false],
    ['an IPv6 host entry never matches an IPv4 peer', ['::1/128'], '1.2.3.4', false],
    ['entries are trimmed', ['  10.0.0.1  '], '10.0.0.1', true],
  ])('%s', (_name, entries, address, expected) => {
    expect(parseTrustedProxies(entries).contains(address)).toBe(expected);
  });

  it('trusts nobody for an empty list', () => {
    expect(parseTrustedProxies([]).contains('127.0.0.1')).toBe(false);
  });

  it.each([
    'banana',
    '10.0.0.1/',
    '10.0.0.1/33',
    '::1/129',
    '10.0.0.1/8/8',
    '10.0.0.1/-1',
    '10.0.0.1/1000',
    '10.0.0.1/ 8',
    '/8',
    '',
    '10.0.0.256',
    'junk/10.0.0.1',
  ])('throws on %j', (entry) => {
    expect(() => parseTrustedProxies([entry])).toThrow(/Invalid trusted proxy entry/);
  });
});

describe('resolveTrustedProxies', () => {
  it('trusts loopback by default', () => {
    const resolved = resolveTrustedProxies(undefined, undefined);
    expect(resolved.contains('127.0.0.1')).toBe(true);
    expect(resolved.contains('::1')).toBe(true);
    expect(resolved.contains('10.0.0.1')).toBe(false);
  });

  it('trusts nobody for an empty env value', () => {
    expect(resolveTrustedProxies(undefined, '').contains('127.0.0.1')).toBe(false);
  });

  it('prefers the configured list over the env', () => {
    expect(resolveTrustedProxies(['1.1.1.1'], '2.2.2.2').contains('2.2.2.2')).toBe(false);
  });

  it('splits the env on commas and skips blanks', () => {
    const resolved = resolveTrustedProxies(undefined, '1.1.1.1, ,2.2.2.2,');
    expect(resolved.contains('1.1.1.1')).toBe(true);
    expect(resolved.contains('2.2.2.2')).toBe(true);
  });
});

describe('clientFromForwardedFor', () => {
  it('returns the single client hop', () => {
    expect(clientFromForwardedFor('203.0.113.9', '10.0.0.1', proxies)).toBe('203.0.113.9');
  });

  it('ignores a spoofed left hop behind the real client', () => {
    expect(clientFromForwardedFor('6.6.6.6, 203.0.113.9', '10.0.0.1', proxies)).toBe('203.0.113.9');
  });

  it('ignores a spoofed left hop even when it names a trusted proxy', () => {
    expect(clientFromForwardedFor('10.9.9.9, 203.0.113.9', '10.0.0.1', proxies)).toBe(
      '203.0.113.9',
    );
  });

  it('walks past trusted proxies on the right', () => {
    expect(
      clientFromForwardedFor('6.6.6.6, 203.0.113.9, 10.0.0.2, 10.0.0.3', '10.0.0.1', proxies),
    ).toBe('203.0.113.9');
  });

  it('returns the leftmost hop when every hop is trusted', () => {
    expect(clientFromForwardedFor('10.0.0.7, 10.0.0.2', '10.0.0.1', proxies)).toBe('10.0.0.7');
  });

  it('keeps the last readable hop when a malformed hop stops the walk', () => {
    expect(clientFromForwardedFor('6.6.6.6, garbage, 10.0.0.2', '10.0.0.1', proxies)).toBe(
      '10.0.0.2',
    );
  });

  it('falls back to the peer when the rightmost hop is malformed', () => {
    expect(clientFromForwardedFor('6.6.6.6, garbage', '10.0.0.1', proxies)).toBe('10.0.0.1');
  });

  it.each([
    '',
    ' ',
    ',',
    'unknown',
    '999.1.1.1',
    '1.2.3',
    '1.2.3.4.5',
    '1.2.3.4:99999',
    '[::1',
    ':80',
  ])('falls back to the peer for %j', (header) => {
    expect(clientFromForwardedFor(header, '10.0.0.1', proxies)).toBe('10.0.0.1');
  });

  it.each([
    ['203.0.113.9:4711', '203.0.113.9'],
    ['203.0.113.9:65535', '203.0.113.9'],
    ['[2001:db8::7]:4711', '2001:db8::7'],
    ['  203.0.113.9  ', '203.0.113.9'],
    ['::ffff:203.0.113.9', '203.0.113.9'],
    ['[::ffff:203.0.113.9]:80', '203.0.113.9'],
    ['2001:db8::7', '2001:db8::7'],
  ])('reads hop %j as %j', (header, expected) => {
    expect(clientFromForwardedFor(header, '10.0.0.1', proxies)).toBe(expected);
  });

  it.each(['203.0.113.9:65536', '203.0.113.9:123456', '[2001:db8::7]:99999', 'evil.example:80'])(
    'refuses a hop with a bad port or host %j',
    (header) => {
      expect(clientFromForwardedFor(header, '10.0.0.1', proxies)).toBe('10.0.0.1');
    },
  );

  it('never lets anything left of the first untrusted hop change the answer', () => {
    fc.assert(
      fc.property(fc.array(fc.ipV4(), { maxLength: 6 }), (spoofed) => {
        const header = [...spoofed, '203.0.113.9', '10.0.0.2'].join(', ');
        expect(clientFromForwardedFor(header, '10.0.0.1', proxies)).toBe('203.0.113.9');
      }),
    );
  });
});

describe('applyClientAddress', () => {
  it('leaves headers alone when there is no peer', () => {
    const headers = { 'x-real-ip': '1.1.1.1', 'x-forwarded-for': '2.2.2.2' };
    applyClientAddress(headers, undefined, proxies);
    expect(headers).toEqual({ 'x-real-ip': '1.1.1.1', 'x-forwarded-for': '2.2.2.2' });
  });

  it('overwrites X-Real-IP and drops X-Forwarded-For for an untrusted peer', () => {
    const headers = { 'x-real-ip': '1.1.1.1', 'x-forwarded-for': '2.2.2.2' };
    applyClientAddress(headers, '203.0.113.9', proxies);
    expect(headers).toEqual({ 'x-real-ip': '203.0.113.9' });
  });

  it('normalizes a mapped untrusted peer', () => {
    const headers: Record<string, string> = {};
    applyClientAddress(headers, '::ffff:203.0.113.9', proxies);
    expect(headers['x-real-ip']).toBe('203.0.113.9');
  });

  it('trusts a mapped peer that is a trusted proxy', () => {
    const headers: Record<string, string> = { 'x-forwarded-for': '203.0.113.9' };
    applyClientAddress(headers, '::ffff:10.0.0.1', proxies);
    expect(headers['x-real-ip']).toBe('203.0.113.9');
  });

  it('uses X-Forwarded-For from a trusted peer', () => {
    const headers = { 'x-real-ip': '1.1.1.1', 'x-forwarded-for': '6.6.6.6, 203.0.113.9' };
    applyClientAddress(headers, '10.0.0.1', proxies);
    expect(headers['x-real-ip']).toBe('203.0.113.9');
  });

  it('uses a valid X-Real-IP from a trusted peer without X-Forwarded-For', () => {
    const headers = { 'x-real-ip': ' 203.0.113.9 ' };
    applyClientAddress(headers, '10.0.0.1', proxies);
    expect(headers['x-real-ip']).toBe('203.0.113.9');
  });

  it.each(['', 'garbage', '999.9.9.9'])(
    'falls back to the peer for trusted peer with X-Real-IP %j',
    (realIp) => {
      const headers = { 'x-real-ip': realIp };
      applyClientAddress(headers, '10.0.0.1', proxies);
      expect(headers['x-real-ip']).toBe('10.0.0.1');
    },
  );

  it('falls back to the peer for a trusted peer with no headers', () => {
    const headers: Record<string, string> = {};
    applyClientAddress(headers, '10.0.0.1', proxies);
    expect(headers['x-real-ip']).toBe('10.0.0.1');
  });
});

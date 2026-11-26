import { describe, expect, it } from 'vitest';
import { applyClientAddress, resolveTrustedProxies } from '../client-address.js';

function apply(
  headers: Record<string, string>,
  peer: string | undefined,
  trusted: string[] = ['10.0.0.0/8'],
) {
  applyClientAddress(headers, peer, resolveTrustedProxies(trusted, undefined));
  return headers;
}

describe('resolveTrustedProxies', () => {
  it('trusts only loopback when nothing is configured and the env var is unset', () => {
    const proxies = resolveTrustedProxies(undefined, undefined);
    expect(proxies.contains('127.0.0.1')).toBe(true);
    expect(proxies.contains('127.5.5.5')).toBe(true);
    expect(proxies.contains('::1')).toBe(true);
    expect(proxies.contains('10.0.0.1')).toBe(false);
    expect(proxies.contains('203.0.113.9')).toBe(false);
  });

  it('an explicit configured list takes precedence over the env var', () => {
    const proxies = resolveTrustedProxies(['192.0.2.1'], '198.51.100.1');
    expect(proxies.contains('192.0.2.1')).toBe(true);
    expect(proxies.contains('198.51.100.1')).toBe(false);
    expect(proxies.contains('127.0.0.1')).toBe(false);
  });

  it('an empty env var trusts no proxy at all', () => {
    const proxies = resolveTrustedProxies(undefined, '');
    expect(proxies.contains('127.0.0.1')).toBe(false);
    expect(proxies.contains('::1')).toBe(false);
    expect(proxies.contains('10.0.0.1')).toBe(false);
  });

  it('a comma separated env list with blank entries trusts the named proxies only', () => {
    const proxies = resolveTrustedProxies(undefined, ' 192.0.2.1 , ,198.51.100.0/24,');
    expect(proxies.contains('192.0.2.1')).toBe(true);
    expect(proxies.contains('198.51.100.77')).toBe(true);
    expect(proxies.contains('192.0.2.2')).toBe(false);
    expect(proxies.contains('127.0.0.1')).toBe(false);
  });

  it.each([['not-an-ip'], ['10.0.0'], ['999.1.1.1'], ['10.0.0.1/abc'], ['']])(
    'rejects an entry that is not an IP or CIDR: %j',
    (entry) => {
      expect(() => resolveTrustedProxies([entry], undefined)).toThrow(/Invalid trusted proxy/);
    },
  );

  it('rejects a CIDR with an empty suffix instead of trusting every peer', () => {
    expect(() => resolveTrustedProxies(['10.0.0.1/'], undefined)).toThrow(/Invalid trusted proxy/);
    expect(() => resolveTrustedProxies(undefined, '10.0.0.1/')).toThrow(/Invalid trusted proxy/);
  });

  it.each([['10.0.0.0/33'], ['::1/129'], ['10.0.0.0/999']])(
    'rejects a prefix longer than 32 for IPv4 and 128 for IPv6: %s',
    (entry) => {
      expect(() => resolveTrustedProxies([entry], undefined)).toThrow(/Invalid trusted proxy/);
    },
  );

  it('accepts the maximum prefix for each family', () => {
    expect(resolveTrustedProxies(['10.0.0.1/32'], undefined).contains('10.0.0.1')).toBe(true);
    expect(resolveTrustedProxies(['::1/128'], undefined).contains('::1')).toBe(true);
  });

  it('rejects an entry with a second slash segment', () => {
    expect(() => resolveTrustedProxies(['10.0.0.0/8/8'], undefined)).toThrow(
      /Invalid trusted proxy/,
    );
  });

  it('matches an IPv4 peer reported as an IPv4-mapped IPv6 address', () => {
    const proxies = resolveTrustedProxies(['10.0.0.0/8'], undefined);
    expect(proxies.contains('::ffff:10.1.2.3')).toBe(true);
    expect(proxies.contains('::ffff:203.0.113.9')).toBe(false);
  });

  it('never trusts a private range that was not listed', () => {
    const proxies = resolveTrustedProxies(['192.0.2.1'], undefined);
    for (const address of ['10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.1.1', 'fd00::1']) {
      expect(proxies.contains(address)).toBe(false);
    }
    expect(proxies.contains('garbage')).toBe(false);
  });
});

describe('applyClientAddress', () => {
  it('leaves the headers alone when there is no peer address', () => {
    const headers = { 'x-real-ip': '1.2.3.4', 'x-forwarded-for': '5.6.7.8' };
    expect(apply({ ...headers }, undefined)).toEqual(headers);
    expect(apply({ ...headers }, '')).toEqual(headers);
  });

  it('overwrites x-real-ip with the socket address and drops x-forwarded-for for an untrusted peer', () => {
    const headers = apply(
      { 'x-real-ip': '1.2.3.4', 'x-forwarded-for': '5.6.7.8, 10.0.0.2', host: 'api' },
      '203.0.113.9',
    );
    expect(headers['x-real-ip']).toBe('203.0.113.9');
    expect(headers).not.toHaveProperty('x-forwarded-for');
    expect(headers['host']).toBe('api');
  });

  it('ignores a spoofed x-real-ip from an untrusted peer', () => {
    expect(apply({ 'x-real-ip': '10.0.0.5' }, '203.0.113.9')['x-real-ip']).toBe('203.0.113.9');
    expect(apply({}, '::ffff:203.0.113.9')['x-real-ip']).toBe('203.0.113.9');
  });

  it('a private peer that was not listed is untrusted too', () => {
    const headers = apply({ 'x-forwarded-for': '1.1.1.1' }, '192.168.0.4');
    expect(headers['x-real-ip']).toBe('192.168.0.4');
    expect(headers).not.toHaveProperty('x-forwarded-for');
  });

  it('with an empty trust list every peer is untrusted, loopback included', () => {
    const headers = apply({ 'x-forwarded-for': '1.1.1.1' }, '127.0.0.1', []);
    expect(headers['x-real-ip']).toBe('127.0.0.1');
    expect(headers).not.toHaveProperty('x-forwarded-for');
  });

  it('uses the rightmost non-proxy x-forwarded-for hop behind a trusted proxy', () => {
    expect(apply({ 'x-forwarded-for': '203.0.113.9' }, '10.0.0.1')['x-real-ip']).toBe(
      '203.0.113.9',
    );
  });

  it('ignores client-written hops left of the first untrusted hop', () => {
    const headers = apply({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }, '10.0.0.1');
    expect(headers['x-real-ip']).toBe('203.0.113.9');
    expect(
      apply({ 'x-forwarded-for': '6.6.6.6, 7.7.7.7, 203.0.113.9, 10.0.0.2' }, '10.0.0.1')[
        'x-real-ip'
      ],
    ).toBe('203.0.113.9');
  });

  it('walks through several trusted proxy hops to the real client', () => {
    expect(
      apply({ 'x-forwarded-for': '203.0.113.9, 10.0.0.3, 10.0.0.2' }, '10.0.0.1')['x-real-ip'],
    ).toBe('203.0.113.9');
  });

  it('when every hop is a trusted proxy the leftmost hop is the client', () => {
    expect(apply({ 'x-forwarded-for': '10.0.0.9, 10.0.0.3' }, '10.0.0.1')['x-real-ip']).toBe(
      '10.0.0.9',
    );
  });

  it('stops at a malformed hop and uses the last readable one', () => {
    expect(
      apply({ 'x-forwarded-for': '203.0.113.9, garbage, 10.0.0.3' }, '10.0.0.1')['x-real-ip'],
    ).toBe('10.0.0.3');
    expect(apply({ 'x-forwarded-for': '203.0.113.9, garbage' }, '10.0.0.1')['x-real-ip']).toBe(
      '10.0.0.1',
    );
    expect(apply({ 'x-forwarded-for': '203.0.113.9, ' }, '10.0.0.1')['x-real-ip']).toBe('10.0.0.1');
  });

  it('accepts a hop with a port suffix for IPv4 and bracketed IPv6', () => {
    expect(apply({ 'x-forwarded-for': '203.0.113.9:4711' }, '10.0.0.1')['x-real-ip']).toBe(
      '203.0.113.9',
    );
    expect(apply({ 'x-forwarded-for': '[2001:db8::1]:4711' }, '10.0.0.1')['x-real-ip']).toBe(
      '2001:db8::1',
    );
    expect(apply({ 'x-forwarded-for': '2001:db8::1' }, '10.0.0.1')['x-real-ip']).toBe(
      '2001:db8::1',
    );
  });

  it('rejects a hop whose port is above 65535', () => {
    expect(apply({ 'x-forwarded-for': '203.0.113.9:65536' }, '10.0.0.1')['x-real-ip']).toBe(
      '10.0.0.1',
    );
    expect(apply({ 'x-forwarded-for': '[2001:db8::1]:70000' }, '10.0.0.1')['x-real-ip']).toBe(
      '10.0.0.1',
    );
    expect(apply({ 'x-forwarded-for': '203.0.113.9:65535' }, '10.0.0.1')['x-real-ip']).toBe(
      '203.0.113.9',
    );
  });

  it('falls back to the proxy x-real-ip when x-forwarded-for is absent and it is a valid IP', () => {
    expect(apply({ 'x-real-ip': ' 203.0.113.9 ' }, '10.0.0.1')['x-real-ip']).toBe('203.0.113.9');
    expect(apply({ 'x-real-ip': '::ffff:203.0.113.9' }, '10.0.0.1')['x-real-ip']).toBe(
      '203.0.113.9',
    );
  });

  it('falls back to the proxy socket address when x-real-ip is garbage', () => {
    expect(apply({ 'x-real-ip': 'evil<script>' }, '10.0.0.1')['x-real-ip']).toBe('10.0.0.1');
    expect(apply({ 'x-real-ip': '203.0.113.9:80' }, '10.0.0.1')['x-real-ip']).toBe('10.0.0.1');
  });

  it('never leaves x-real-ip empty behind a trusted proxy', () => {
    const cases: Record<string, string>[] = [
      {},
      { 'x-real-ip': '' },
      { 'x-forwarded-for': '' },
      { 'x-forwarded-for': ',,,' },
      { 'x-forwarded-for': 'garbage', 'x-real-ip': 'garbage' },
    ];
    for (const headers of cases) {
      const result = apply({ ...headers }, '10.0.0.1');
      expect(result['x-real-ip']).toBe('10.0.0.1');
    }
  });

  it('prefers x-forwarded-for over a client-supplied x-real-ip passed through by the proxy', () => {
    const headers = apply({ 'x-real-ip': '6.6.6.6', 'x-forwarded-for': '203.0.113.9' }, '10.0.0.1');
    expect(headers['x-real-ip']).toBe('203.0.113.9');
  });
});

import { describe, it, expect } from 'vitest';
import {
  applyClientAddress,
  parseTrustedProxies,
  resolveTrustedProxies,
  DEFAULT_TRUSTED_PROXIES,
} from '../client-address.js';

const defaults = parseTrustedProxies(DEFAULT_TRUSTED_PROXIES);
const privateProxy = parseTrustedProxies(['172.16.0.0/12']);

describe('applyClientAddress', () => {
  it('replaces a direct caller’s forwarding headers with its socket address', () => {
    const headers = { 'x-real-ip': '198.51.100.1', 'x-forwarded-for': '198.51.100.2' };
    applyClientAddress(headers, '203.0.113.7', defaults);
    expect(headers).toEqual({ 'x-real-ip': '203.0.113.7' });
  });

  it('keeps the headers a trusted proxy set', () => {
    const headers = { 'x-real-ip': '198.51.100.1', 'x-forwarded-for': '198.51.100.1' };
    applyClientAddress(headers, '172.18.0.5', privateProxy);
    expect(headers).toEqual({ 'x-real-ip': '198.51.100.1', 'x-forwarded-for': '198.51.100.1' });
  });

  it('does not trust a direct private peer by default', () => {
    const headers = { 'x-real-ip': '198.51.100.1', 'x-forwarded-for': '198.51.100.1' };
    applyClientAddress(headers, '10.0.0.2', defaults);
    expect(headers).toEqual({ 'x-real-ip': '10.0.0.2' });
  });

  it('falls back to a trusted peer’s own address when it sent no forwarding header', () => {
    const headers: Record<string, string> = {};
    applyClientAddress(headers, '::ffff:127.0.0.1', defaults);
    expect(headers).toEqual({ 'x-real-ip': '127.0.0.1' });
  });

  it('treats an IPv4-mapped public peer as the IPv4 address it is', () => {
    const headers = { 'x-real-ip': '10.0.0.1' };
    applyClientAddress(headers, '::ffff:203.0.113.7', defaults);
    expect(headers).toEqual({ 'x-real-ip': '203.0.113.7' });
  });

  it('leaves an in-process request with no socket untouched', () => {
    const headers = { 'x-real-ip': '198.51.100.1' };
    applyClientAddress(headers, undefined, defaults);
    expect(headers).toEqual({ 'x-real-ip': '198.51.100.1' });
  });

  it('derives the client from X-Forwarded-For when a trusted proxy sends only that', () => {
    const headers: Record<string, string> = { 'x-forwarded-for': '198.51.100.9' };
    applyClientAddress(headers, '10.0.0.2', parseTrustedProxies(['10.0.0.0/8']));
    expect(headers['x-real-ip']).toBe('198.51.100.9');
  });

  it('ignores X-Forwarded-For entries the client wrote ahead of the proxy’s', () => {
    const headers: Record<string, string> = { 'x-forwarded-for': '1.1.1.1, 198.51.100.9' };
    applyClientAddress(headers, '10.0.0.2', parseTrustedProxies(['10.0.0.0/8']));
    expect(headers['x-real-ip']).toBe('198.51.100.9');
  });

  it('skips trusted hops when several proxies are chained', () => {
    const headers: Record<string, string> = { 'x-forwarded-for': '198.51.100.9, 10.0.0.3' };
    applyClientAddress(headers, '10.0.0.2', parseTrustedProxies(['10.0.0.0/8']));
    expect(headers['x-real-ip']).toBe('198.51.100.9');
  });

  it('stops at a malformed X-Forwarded-For hop instead of using it', () => {
    const headers: Record<string, string> = { 'x-forwarded-for': '198.51.100.9, garbage' };
    applyClientAddress(headers, '10.0.0.2', parseTrustedProxies(['10.0.0.0/8']));
    expect(headers['x-real-ip']).toBe('10.0.0.2');
  });

  it('never leaves a trusted request without an address', () => {
    const headers: Record<string, string> = { 'x-real-ip': 'not-an-ip' };
    applyClientAddress(headers, '10.0.0.2', parseTrustedProxies(['10.0.0.0/8']));
    expect(headers['x-real-ip']).toBe('10.0.0.2');
  });

  it('prefers a trusted proxy’s appended XFF address over a spoofed X-Real-IP', () => {
    const headers = { 'x-real-ip': '198.51.100.66', 'x-forwarded-for': '203.0.113.9' };
    applyClientAddress(headers, '10.0.0.2', parseTrustedProxies(['10.0.0.0/8']));
    expect(headers['x-real-ip']).toBe('203.0.113.9');
  });

  it('accepts XFF addresses with a client port', () => {
    const headers: Record<string, string> = { 'x-forwarded-for': '203.0.113.9:443' };
    applyClientAddress(headers, '10.0.0.2', parseTrustedProxies(['10.0.0.0/8']));
    expect(headers['x-real-ip']).toBe('203.0.113.9');
  });

  it('accepts bracketed IPv6 XFF addresses with a client port', () => {
    const headers: Record<string, string> = { 'x-forwarded-for': '[2001:db8::9]:443' };
    applyClientAddress(headers, '10.0.0.2', parseTrustedProxies(['10.0.0.0/8']));
    expect(headers['x-real-ip']).toBe('2001:db8::9');
  });

  it('trusts no peer at all with an empty list', () => {
    const headers = { 'x-real-ip': '198.51.100.1' };
    applyClientAddress(headers, '127.0.0.1', parseTrustedProxies([]));
    expect(headers).toEqual({ 'x-real-ip': '127.0.0.1' });
  });
});

describe('parseTrustedProxies', () => {
  it('accepts single addresses and CIDRs of both families', () => {
    const trusted = parseTrustedProxies(['203.0.113.7', '198.51.100.0/24', '2001:db8::/32']);
    expect(trusted.contains('203.0.113.7')).toBe(true);
    expect(trusted.contains('198.51.100.200')).toBe(true);
    expect(trusted.contains('2001:db8::1')).toBe(true);
    expect(trusted.contains('203.0.113.8')).toBe(false);
  });

  it.each([
    'not-an-ip',
    '10.0.0.0/33',
    '10.0.0.0/x',
    '::1/129',
    '',
    // `Number('')` is 0: an empty suffix must not become a /0 that trusts every peer.
    '10.0.0.1/',
    '10.0.0.0/8/9',
    '10.0.0.0/-1',
    '10.0.0.0/ 8',
  ])('refuses %j so a typo fails the boot', (entry) => {
    expect(() => parseTrustedProxies([entry])).toThrow(/Invalid trusted proxy entry/);
  });
});

describe('resolveTrustedProxies', () => {
  it('prefers explicit config over the environment', () => {
    const trusted = resolveTrustedProxies(['203.0.113.7'], '198.51.100.1');
    expect(trusted.contains('203.0.113.7')).toBe(true);
    expect(trusted.contains('198.51.100.1')).toBe(false);
  });

  it('reads a comma-separated environment list, where empty trusts nobody', () => {
    expect(resolveTrustedProxies(undefined, ' 203.0.113.7 , ').contains('203.0.113.7')).toBe(true);
    expect(resolveTrustedProxies(undefined, '').contains('127.0.0.1')).toBe(false);
  });

  it('defaults to loopback only', () => {
    const trusted = resolveTrustedProxies(undefined, undefined);
    expect(trusted.contains('127.0.0.1')).toBe(true);
    expect(trusted.contains('10.1.2.3')).toBe(false);
    expect(trusted.contains('203.0.113.7')).toBe(false);
  });
});

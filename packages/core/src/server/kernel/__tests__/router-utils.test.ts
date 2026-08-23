import { describe, it, expect } from 'vitest';
import { ORPCError } from '@orpc/server';
import { getUserId, extractClientMeta, type NodeHeaders } from '../router-utils.js';

const withRequest = (extra: Record<string, unknown> = {}) => ({
  request: { headers: {} },
  ...extra,
});

const reasonOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return (err as ORPCError<string, { reason: string }>).data.reason;
  }
  throw new Error('expected getUserId to throw');
};

describe('getUserId', () => {
  it('returns the resolved caller id', () => {
    expect(getUserId(withRequest({ auth: { userId: 'user-1' } }))).toBe('user-1');
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a primitive', 'not-a-context'],
    ['an object without request', { auth: { userId: 'user-1' } }],
    ['a context whose request is not an object', { request: 'GET /' }],
  ])('rejects %s as a missing request context', (_label, context) => {
    expect(reasonOf(() => getUserId(context))).toBe('missing_request_context');
  });

  it.each([
    ['no auth at all', withRequest()],
    ['an auth without a userId', withRequest({ auth: {} })],
    ['an empty userId', withRequest({ auth: { userId: '' } })],
  ])('rejects %s as unauthenticated', (_label, context) => {
    expect(reasonOf(() => getUserId(context))).toBe('authentication_required');
  });

  it('throws UNAUTHORIZED rather than a bare Error', () => {
    expect(() => getUserId(undefined)).toThrow(ORPCError);
  });
});

describe('extractClientMeta', () => {
  const meta = (headers: NodeHeaders) => extractClientMeta(headers);
  const trusted = (headers: NodeHeaders) => extractClientMeta(headers, { trustForwarded: true });

  it('ignores x-forwarded-for without a trusted proxy boundary', () => {
    expect(meta({ 'x-forwarded-for': '203.0.113.7' }).ip).toBeNull();
  });

  it('ignores a spoofed x-forwarded-for in favour of x-real-ip', () => {
    expect(meta({ 'x-forwarded-for': '203.0.113.7', 'x-real-ip': '198.51.100.4' }).ip).toBe(
      '198.51.100.4',
    );
  });

  it('reads a single x-forwarded-for entry when forwarding is trusted', () => {
    expect(trusted({ 'x-forwarded-for': '203.0.113.7' }).ip).toBe('203.0.113.7');
  });

  it('takes the leftmost hop of a proxy chain and trims it', () => {
    expect(trusted({ 'x-forwarded-for': ' 203.0.113.7 , 10.0.0.1, 10.0.0.2' }).ip).toBe(
      '203.0.113.7',
    );
  });

  it('takes the first value when the header arrives repeated', () => {
    expect(trusted({ 'x-forwarded-for': ['203.0.113.7', '198.51.100.4'] }).ip).toBe('203.0.113.7');
  });

  it('falls back to x-real-ip when x-forwarded-for is absent', () => {
    expect(trusted({ 'x-real-ip': '198.51.100.4' }).ip).toBe('198.51.100.4');
  });

  it('falls back to x-real-ip when x-forwarded-for is empty', () => {
    expect(trusted({ 'x-forwarded-for': '', 'x-real-ip': '198.51.100.4' }).ip).toBe('198.51.100.4');
  });

  it('prefers x-forwarded-for over x-real-ip when forwarding is trusted', () => {
    expect(trusted({ 'x-forwarded-for': '203.0.113.7', 'x-real-ip': '198.51.100.4' }).ip).toBe(
      '203.0.113.7',
    );
  });

  it('reads the first x-real-ip when that header arrives repeated', () => {
    expect(meta({ 'x-real-ip': ['198.51.100.4', '198.51.100.9'] }).ip).toBe('198.51.100.4');
  });

  it('carries the user agent through', () => {
    expect(meta({ 'user-agent': 'curl/8.4.0' }).userAgent).toBe('curl/8.4.0');
  });

  it('takes the first user agent when the header arrives repeated', () => {
    expect(meta({ 'user-agent': ['curl/8.4.0', 'wget'] }).userAgent).toBe('curl/8.4.0');
  });

  it('returns nulls rather than undefined for an empty header bag', () => {
    expect(meta({})).toEqual({ ip: null, userAgent: null });
  });

  it('returns nulls when the headers are present but undefined', () => {
    expect(meta({ 'x-forwarded-for': undefined, 'user-agent': undefined })).toEqual({
      ip: null,
      userAgent: null,
    });
  });
});

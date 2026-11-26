import { createHmac } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isSignedBy, parseInternalApiSecrets, signInternalRequest } from '../internal-api.js';

const SECRET_A = 'a'.repeat(32);
const SECRET_B = 'b'.repeat(40);
const encoder = new TextEncoder();

const request = (over: Partial<Parameters<typeof signInternalRequest>[0]> = {}) => ({
  service: 'wallet',
  audience: 'api',
  timestamp: '1700000000000',
  method: 'POST',
  pathAndQuery: '/internal/v1/ping?x=1',
  contentType: 'application/json',
  body: encoder.encode('{"a":1}'),
  ...over,
});

const headersFor = (signed: ReturnType<typeof request>, secret: string) => ({
  service: signed.service,
  timestamp: signed.timestamp,
  signature: signInternalRequest(signed, secret),
});

describe('parseInternalApiSecrets', () => {
  it.each([undefined, '', '   ', ',', ' , ,'])('returns no secrets for %j', (raw) => {
    expect(parseInternalApiSecrets(raw)).toEqual([]);
  });

  it('keeps the order so the first signs', () => {
    expect(parseInternalApiSecrets(`${SECRET_A},${SECRET_B}`)).toEqual([SECRET_A, SECRET_B]);
  });

  it('trims whitespace and drops blanks', () => {
    expect(parseInternalApiSecrets(` ${SECRET_A} , ,${SECRET_B},`)).toEqual([SECRET_A, SECRET_B]);
  });

  it('accepts a secret of exactly 32 characters', () => {
    expect(parseInternalApiSecrets('x'.repeat(32))).toEqual(['x'.repeat(32)]);
  });

  it('throws on a secret of 31 characters', () => {
    expect(() => parseInternalApiSecrets('x'.repeat(31))).toThrow(/at least 32/);
  });

  it('throws when one secret of the list is short', () => {
    expect(() => parseInternalApiSecrets(`${SECRET_A},short`)).toThrow(/at least 32/);
  });

  it('counts the trimmed length, not the padded one', () => {
    expect(() => parseInternalApiSecrets(`  ${'x'.repeat(31)}  `)).toThrow(/at least 32/);
  });

  it('tells the operator how to generate a secret', () => {
    expect(() => parseInternalApiSecrets('short')).toThrow(/openssl rand -hex 32/);
  });
});

describe('signInternalRequest', () => {
  it('signs the canonical lines with the method in upper case', () => {
    const canonical = [
      'wallet',
      'api',
      '1700000000000',
      'POST',
      '/internal/v1/ping?x=1',
      'application/json',
      '015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862',
    ].join('\n');
    const expected = createHmac('sha256', SECRET_A).update(canonical).digest('hex');
    expect(signInternalRequest(request({ method: 'post' }), SECRET_A)).toBe(expected);
  });

  it('returns 64 lowercase hex characters', () => {
    expect(signInternalRequest(request(), SECRET_A)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable for the same input', () => {
    expect(signInternalRequest(request(), SECRET_A)).toBe(signInternalRequest(request(), SECRET_A));
  });

  it('upper-cases the method', () => {
    expect(signInternalRequest(request({ method: 'post' }), SECRET_A)).toBe(
      signInternalRequest(request({ method: 'POST' }), SECRET_A),
    );
  });

  it.each([
    ['service', { service: 'other' }],
    ['audience', { audience: 'other' }],
    ['timestamp', { timestamp: '1700000000001' }],
    ['method', { method: 'GET' }],
    ['path', { pathAndQuery: '/internal/v1/ping?x=2' }],
    ['content type', { contentType: 'text/plain' }],
    ['body', { body: encoder.encode('{"a":2}') }],
  ])('changes with the %s', (_field, over) => {
    expect(signInternalRequest(request(over), SECRET_A)).not.toBe(
      signInternalRequest(request(), SECRET_A),
    );
  });

  it('does not let a field boundary shift between service and audience', () => {
    expect(signInternalRequest(request({ service: 'ab', audience: 'c' }), SECRET_A)).not.toBe(
      signInternalRequest(request({ service: 'a', audience: 'bc' }), SECRET_A),
    );
  });
});

describe('isSignedBy', () => {
  it('accepts a request signed with the only secret', () => {
    const signed = request();
    expect(isSignedBy(headersFor(signed, SECRET_A), signed, [SECRET_A])).toBe(true);
  });

  it('accepts a request signed with the second secret during rotation', () => {
    const signed = request();
    expect(isSignedBy(headersFor(signed, SECRET_B), signed, [SECRET_A, SECRET_B])).toBe(true);
  });

  it('accepts a request signed with the old secret after the new one was prepended', () => {
    const signed = request();
    expect(isSignedBy(headersFor(signed, SECRET_A), signed, [SECRET_B, SECRET_A])).toBe(true);
  });

  it('refuses a secret that was dropped from the list', () => {
    const signed = request();
    expect(isSignedBy(headersFor(signed, SECRET_A), signed, [SECRET_B])).toBe(false);
  });

  it('refuses every request when no secret is configured', () => {
    const signed = request();
    expect(isSignedBy(headersFor(signed, SECRET_A), signed, [])).toBe(false);
  });

  it.each([
    ['body', { body: encoder.encode('{"a":2}') }],
    ['empty body', { body: new Uint8Array() }],
    ['path', { pathAndQuery: '/internal/v1/other' }],
    ['query', { pathAndQuery: '/internal/v1/ping?x=2' }],
    ['method', { method: 'DELETE' }],
    ['content type', { contentType: 'application/xml' }],
    ['audience', { audience: 'other-service' }],
  ])('refuses a request whose %s was tampered with', (_field, over) => {
    const signed = request();
    expect(isSignedBy(headersFor(signed, SECRET_A), request(over), [SECRET_A])).toBe(false);
  });

  it('refuses a replayed signature under another service or timestamp', () => {
    const signed = request();
    const headers = headersFor(signed, SECRET_A);
    expect(isSignedBy({ ...headers, service: 'other' }, signed, [SECRET_A])).toBe(false);
    expect(isSignedBy({ ...headers, timestamp: '1700000000001' }, signed, [SECRET_A])).toBe(false);
  });

  it('refuses a flipped signature character', () => {
    const signed = request();
    const headers = headersFor(signed, SECRET_A);
    const flipped = `${headers.signature[0] === '0' ? '1' : '0'}${headers.signature.slice(1)}`;
    expect(isSignedBy({ ...headers, signature: flipped }, signed, [SECRET_A])).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['too short', 'ab'.repeat(31)],
    ['too long', 'ab'.repeat(33)],
    ['odd length', 'a'.repeat(63)],
  ])('refuses a %s signature without throwing', (_name, signature) => {
    const signed = request();
    const headers = headersFor(signed, SECRET_A);
    expect(isSignedBy({ ...headers, signature }, signed, [SECRET_A])).toBe(false);
  });

  it('accepts only the signature made for the exact content', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (bodyA, bodyB) => {
        fc.pre(bodyA !== bodyB);
        const signed = request({ body: encoder.encode(bodyA) });
        const headers = headersFor(signed, SECRET_A);
        expect(isSignedBy(headers, signed, [SECRET_A])).toBe(true);
        expect(isSignedBy(headers, request({ body: encoder.encode(bodyB) }), [SECRET_A])).toBe(
          false,
        );
      }),
    );
  });
});

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
  RateLimitKey,
  RateLimitOptions,
  RateLimitResult,
  RateLimiterAdapter,
} from '@openora/core/contracts';
import {
  accessDenied,
  batchRefused,
  bearerRequired,
  consumeAddressRateLimit,
  consumeTokenRateLimit,
  internalError,
  invalidToken,
  methodNotAllowed,
  noStore,
  originRefused,
  originVerdict,
  parseBearer,
  parseError,
  payloadTooLarge,
  preflight,
  rateLimitRefused,
  servesHost,
  withHeaders,
} from '../transport-gate.js';

type Consumed = { key: RateLimitKey; opts: RateLimitOptions };

function scriptedLimiter(results: RateLimitResult[]) {
  const calls: Consumed[] = [];
  const limiter: RateLimiterAdapter<RateLimitKey> = {
    async consume(key, opts) {
      calls.push({ key, opts });
      return results[calls.length - 1] ?? { allowed: true, retryAfterMs: 0 };
    },
    async reset() {},
  };
  return { limiter, calls };
}

const ALLOWED: RateLimitResult = { allowed: true, retryAfterMs: 0 };
const UNAVAILABLE: RateLimitResult = { allowed: false, retryAfterMs: 0, unavailable: true };

describe('parseBearer', () => {
  it('returns the token from a well formed bearer header', () => {
    expect(parseBearer('Bearer abc.DEF-123_x~y+z/w==')).toBe('abc.DEF-123_x~y+z/w==');
    expect(parseBearer('bearer token')).toBe('token');
  });

  it('returns null for a missing header', () => {
    expect(parseBearer(null)).toBeNull();
  });

  it('returns null for a header over the length cap', () => {
    expect(parseBearer(`Bearer ${'a'.repeat(512 - 7)}`)).toBe('a'.repeat(512 - 7));
    expect(parseBearer(`Bearer ${'a'.repeat(512 - 6)}`)).toBeNull();
  });

  it.each([
    ['Basic dXNlcjpwYXNz'],
    ['Bearer'],
    ['Bearer '],
    ['Bearer   '],
    ['Token abc'],
    ['Bearer a b'],
    ['Bearer a=b'],
    ['Bearer a\nb'],
    [''],
  ])('returns null for a non-bearer scheme or an empty token: %j', (header) => {
    expect(parseBearer(header)).toBeNull();
  });
});

describe('servesHost and originVerdict', () => {
  it('matches a host case-insensitively against the allow-list', () => {
    expect(servesHost('MCP.Example.COM', ['mcp.example.com'])).toBe(true);
  });

  it('refuses a host that is not listed', () => {
    expect(servesHost('evil.example.com', ['mcp.example.com'])).toBe(false);
    expect(servesHost('mcp.example.com.evil.io', ['mcp.example.com'])).toBe(false);
  });

  it('a request without an Origin header is none', () => {
    expect(originVerdict(null, ['https://app.example.com'])).toBe('none');
    expect(originVerdict(null, [])).toBe('none');
  });

  it('a listed Origin is allowed', () => {
    expect(originVerdict('https://app.example.com', ['https://app.example.com'])).toBe('allowed');
  });

  it('an unlisted Origin is refused', () => {
    expect(originVerdict('https://evil.example.com', ['https://app.example.com'])).toBe('refused');
    expect(originVerdict('https://app.example.com/', ['https://app.example.com'])).toBe('refused');
  });

  it('an empty allow-list refuses every request that carries an Origin', () => {
    expect(originVerdict('https://app.example.com', [])).toBe('refused');
    expect(originVerdict('null', [])).toBe('refused');
  });
});

describe('rate limits', () => {
  it('an unknown client address is not limited', async () => {
    const { limiter, calls } = scriptedLimiter([UNAVAILABLE]);
    expect(await consumeAddressRateLimit(limiter, null, 5)).toEqual({ status: 'allowed' });
    expect(calls).toHaveLength(0);
  });

  it('the address minute window refuses once the limit is spent and reports retry-after rounded up to at least 1 second', async () => {
    const { limiter, calls } = scriptedLimiter([
      ALLOWED,
      { allowed: false, retryAfterMs: 1200 },
      { allowed: false, retryAfterMs: 0 },
    ]);
    expect(await consumeAddressRateLimit(limiter, '203.0.113.9', 2)).toEqual({
      status: 'allowed',
    });
    expect(await consumeAddressRateLimit(limiter, '203.0.113.9', 2)).toEqual({
      status: 'limited',
      retryAfterSeconds: 2,
    });
    expect(await consumeAddressRateLimit(limiter, '203.0.113.9', 2)).toEqual({
      status: 'limited',
      retryAfterSeconds: 1,
    });
    expect(calls[0]?.key).toBe('mcp-ip-min:203.0.113.9');
    expect(calls[0]?.opts).toEqual({ limit: 2, windowMs: 60_000, onUnavailable: 'deny' });
  });

  it('a token minute refusal does not count against the day window', async () => {
    const { limiter, calls } = scriptedLimiter([{ allowed: false, retryAfterMs: 4000 }]);
    const verdict = await consumeTokenRateLimit(limiter, randomUUID(), {
      perMinute: 3,
      perDay: 100,
    });
    expect(verdict).toEqual({ status: 'limited', retryAfterSeconds: 4 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.opts.windowMs).toBe(60_000);
  });

  it('a token past its day limit is limited', async () => {
    const { limiter, calls } = scriptedLimiter([
      ALLOWED,
      { allowed: false, retryAfterMs: 3_600_000 },
    ]);
    const verdict = await consumeTokenRateLimit(limiter, randomUUID(), {
      perMinute: 3,
      perDay: 100,
    });
    expect(verdict).toEqual({ status: 'limited', retryAfterSeconds: 3600 });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.opts).toEqual({ limit: 100, windowMs: 86_400_000, onUnavailable: 'deny' });
  });

  it('a token inside both windows is allowed', async () => {
    const { limiter } = scriptedLimiter([ALLOWED, ALLOWED]);
    expect(
      await consumeTokenRateLimit(limiter, randomUUID(), { perMinute: 3, perDay: 100 }),
    ).toEqual({ status: 'allowed' });
  });

  it('a limiter that is unavailable fails closed for the address window', async () => {
    const { limiter, calls } = scriptedLimiter([UNAVAILABLE]);
    expect(await consumeAddressRateLimit(limiter, '203.0.113.9', 5)).toEqual({
      status: 'unavailable',
    });
    expect(calls[0]?.opts.onUnavailable).toBe('deny');
  });

  it('a limiter that is unavailable fails closed for the token windows', async () => {
    const minute = scriptedLimiter([UNAVAILABLE]);
    expect(
      await consumeTokenRateLimit(minute.limiter, randomUUID(), { perMinute: 3, perDay: 100 }),
    ).toEqual({ status: 'unavailable' });
    expect(minute.calls).toHaveLength(1);

    const day = scriptedLimiter([ALLOWED, UNAVAILABLE]);
    expect(
      await consumeTokenRateLimit(day.limiter, randomUUID(), { perMinute: 3, perDay: 100 }),
    ).toEqual({ status: 'unavailable' });
    expect(day.calls.every((call) => call.opts.onUnavailable === 'deny')).toBe(true);
  });
});

type RpcBody = { jsonrpc: string; id: null; error: { code: number; message: string } };

async function body(response: Response): Promise<RpcBody> {
  return response.json();
}

describe('refusal responses', () => {
  it.each([
    ['originRefused', originRefused, 403, -32000],
    ['methodNotAllowed', methodNotAllowed, 405, -32000],
    ['bearerRequired', bearerRequired, 401, -32000],
    ['invalidToken', invalidToken, 401, -32000],
    ['accessDenied', accessDenied, 403, -32000],
    ['payloadTooLarge', payloadTooLarge, 413, -32000],
    ['parseError', parseError, 400, -32700],
    ['batchRefused', batchRefused, 400, -32600],
    ['internalError', internalError, 500, -32603],
    [
      'rateLimited',
      () => rateLimitRefused({ status: 'limited', retryAfterSeconds: 7 }),
      429,
      -32000,
    ],
    ['limiterUnavailable', () => rateLimitRefused({ status: 'unavailable' }), 503, -32000],
  ])(
    'each refusal is a JSON-RPC error with no-store and the right status: %s',
    async (_name, make, status, code) => {
      const response = make();
      expect(response.status).toBe(status);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(response.headers.get('Content-Type')).toBe('application/json');
      const parsed = await body(response);
      expect(parsed.jsonrpc).toBe('2.0');
      expect(parsed.id).toBeNull();
      expect(parsed.error.code).toBe(code);
      expect(typeof parsed.error.message).toBe('string');
    },
  );

  it('auth challenges differ: bearer required is a bare challenge, invalid token names the error, access denied has none', () => {
    expect(bearerRequired().headers.get('WWW-Authenticate')).toBe('Bearer');
    expect(invalidToken().headers.get('WWW-Authenticate')).toBe('Bearer error="invalid_token"');
    expect(accessDenied().headers.get('WWW-Authenticate')).toBeNull();
    expect(methodNotAllowed().headers.get('Allow')).toBe('POST');
  });

  it('rate limit refusal carries a Retry-After header', () => {
    expect(
      rateLimitRefused({ status: 'limited', retryAfterSeconds: 7 }).headers.get('Retry-After'),
    ).toBe('7');
    expect(rateLimitRefused({ status: 'unavailable' }).headers.get('Retry-After')).toBe('30');
  });

  it('preflight answers only for the requesting origin', () => {
    const response = preflight('https://app.example.com');
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example.com');
    expect(response.headers.get('Vary')).toBe('Origin');
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('POST');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('withHeaders keeps the original body and status', async () => {
    const original = new Response('hello', { status: 202, headers: { 'X-Keep': '1' } });
    const next = withHeaders(original, { 'X-Extra': '2' });
    expect(next.status).toBe(202);
    expect(await next.text()).toBe('hello');
    expect(next.headers.get('X-Keep')).toBe('1');
    expect(next.headers.get('X-Extra')).toBe('2');
  });

  it('noStore overrides a cacheable response', () => {
    const next = noStore(new Response('x', { headers: { 'Cache-Control': 'public, max-age=60' } }));
    expect(next.headers.get('Cache-Control')).toBe('no-store');
  });
});

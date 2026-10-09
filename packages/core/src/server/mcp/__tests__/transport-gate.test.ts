import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
  RateLimitKey,
  RateLimitOptions,
  RateLimitResult,
  RateLimiterAdapter,
} from '@openora/core/contracts';
import { mock } from '../../../testing/mock.js';
import {
  accessDenied,
  batchRefused,
  bearerRequired,
  consumeAddressRateLimit,
  consumeTokenRateLimit,
  internalError,
  invalidToken,
  limiterUnavailable,
  methodNotAllowed,
  noStore,
  originRefused,
  originVerdict,
  parseBearer,
  parseError,
  payloadTooLarge,
  preflight,
  rateLimitRefused,
  rateLimited,
  retryAfterSeconds,
  servesHost,
} from '../transport-gate.js';

const BACKOFFICE = 'https://backoffice.example.com';
const CLIENT_IP = '203.0.113.7';
const LIMITS = { perMinute: 60, perDay: 2000 };
const PER_IP_PER_MINUTE = 300;
const ALLOWED: RateLimitResult = { allowed: true, retryAfterMs: 0 };
const STORE_DOWN: RateLimitResult = { allowed: false, retryAfterMs: 60_000, unavailable: true };

type Window = 'ip' | 'min' | 'day';

const WINDOW_PREFIXES: Record<Window, string> = {
  ip: 'mcp-ip-min:',
  min: 'mcp-token-min:',
  day: 'mcp-token-day:',
};

function windowOf(key: RateLimitKey): Window | undefined {
  return (['ip', 'min', 'day'] as const).find((window) => key.startsWith(WINDOW_PREFIXES[window]));
}

function scriptedLimiter(results: Partial<Record<Window, RateLimitResult>>) {
  const consume = vi.fn(
    async (key: RateLimitKey, _options: RateLimitOptions): Promise<RateLimitResult> => {
      const window = windowOf(key);
      return (window && results[window]) ?? ALLOWED;
    },
  );
  return { limiter: mock<RateLimiterAdapter<RateLimitKey>>({ consume }), consume };
}

describe('parseBearer', () => {
  it.each([
    ['Bearer ora_mcp_abc-DEF_123', 'ora_mcp_abc-DEF_123'],
    ['bearer token', 'token'],
    ['BEARER token', 'token'],
    ['Bearer   spaced', 'spaced'],
    ['Bearer dG9rZW4=', 'dG9rZW4='],
    ['Bearer a.b~c+d/e', 'a.b~c+d/e'],
  ])('reads the token of %j', (header, token) => {
    expect(parseBearer(header)).toBe(token);
  });

  it.each([
    [null],
    [''],
    ['Bearer'],
    ['Bearer '],
    ['Bearertoken'],
    ['Basic dXNlcjpwYXNz'],
    ['Bearer two tokens'],
    ['Bearer x=y'],
    ['Bearer tok"en'],
  ])('refuses %j', (header) => {
    expect(parseBearer(header)).toBeNull();
  });

  it('refuses a header longer than 512 characters', () => {
    expect(parseBearer(`Bearer ${'a'.repeat(505)}`)).toBe('a'.repeat(505));
    expect(parseBearer(`Bearer ${'a'.repeat(506)}`)).toBeNull();
  });
});

describe('servesHost', () => {
  it('serves no host when none is bound', () => {
    expect(servesHost('player.example.com', [])).toBe(false);
  });

  it('serves a bound host whatever its case or port', () => {
    expect(
      servesHost(new URL('https://Backoffice.Example.com:8443/mcp').hostname, [
        'backoffice.example.com',
      ]),
    ).toBe(true);
    expect(servesHost('BACKOFFICE.example.com', ['backoffice.example.com'])).toBe(true);
  });

  it('refuses any other host, a subdomain of a bound one included', () => {
    expect(servesHost('player.example.com', ['backoffice.example.com'])).toBe(false);
    expect(servesHost('evil.backoffice.example.com', ['backoffice.example.com'])).toBe(false);
  });
});

describe('originVerdict', () => {
  it('sees no browser when the request carries no Origin', () => {
    expect(originVerdict(null, [])).toBe('none');
    expect(originVerdict(null, [BACKOFFICE])).toBe('none');
  });

  it('refuses every Origin when none is allowed', () => {
    expect(originVerdict(BACKOFFICE, [])).toBe('refused');
    expect(originVerdict('null', [])).toBe('refused');
  });

  it('allows only an exact configured origin', () => {
    expect(originVerdict(BACKOFFICE, [BACKOFFICE])).toBe('allowed');
    expect(originVerdict('http://backoffice.example.com', [BACKOFFICE])).toBe('refused');
    expect(originVerdict(`${BACKOFFICE}:8443`, [BACKOFFICE])).toBe('refused');
    expect(originVerdict('https://evil.example', [BACKOFFICE])).toBe('refused');
  });
});

describe('retryAfterSeconds', () => {
  it.each([
    [0, 1],
    [1, 1],
    [1000, 1],
    [1001, 2],
    [59_001, 60],
    [86_400_000, 86_400],
  ])('rounds %i ms up to %i s', (ms, seconds) => {
    expect(retryAfterSeconds(ms)).toBe(seconds);
  });
});

describe('consumeAddressRateLimit', () => {
  it('consumes the address minute window, failing closed', async () => {
    const { limiter, consume } = scriptedLimiter({});

    expect(await consumeAddressRateLimit(limiter, CLIENT_IP, PER_IP_PER_MINUTE)).toEqual({
      status: 'allowed',
    });
    expect(consume.mock.calls).toEqual([
      [`mcp-ip-min:${CLIENT_IP}`, { limit: 300, windowMs: 60_000, onUnavailable: 'deny' }],
    ]);
  });

  it('does not limit a request whose address is unknown', async () => {
    const { limiter, consume } = scriptedLimiter({ ip: STORE_DOWN });

    expect(await consumeAddressRateLimit(limiter, null, PER_IP_PER_MINUTE)).toEqual({
      status: 'allowed',
    });
    expect(consume).not.toHaveBeenCalled();
  });

  it('refuses a spent window with the time until it resets', async () => {
    const { limiter } = scriptedLimiter({ ip: { allowed: false, retryAfterMs: 41_200 } });

    expect(await consumeAddressRateLimit(limiter, CLIENT_IP, PER_IP_PER_MINUTE)).toEqual({
      status: 'limited',
      retryAfterSeconds: 42,
    });
  });

  it('reports a store it cannot reach as unavailable', async () => {
    const { limiter } = scriptedLimiter({ ip: STORE_DOWN });

    expect(await consumeAddressRateLimit(limiter, CLIENT_IP, PER_IP_PER_MINUTE)).toEqual({
      status: 'unavailable',
    });
  });
});

describe('consumeTokenRateLimit', () => {
  const tokenId = randomUUID();

  it('consumes the minute window, then the day window, both failing closed', async () => {
    const { limiter, consume } = scriptedLimiter({});

    expect(await consumeTokenRateLimit(limiter, tokenId, LIMITS)).toEqual({ status: 'allowed' });
    expect(consume.mock.calls).toEqual([
      [`mcp-token-min:${tokenId}`, { limit: 60, windowMs: 60_000, onUnavailable: 'deny' }],
      [`mcp-token-day:${tokenId}`, { limit: 2000, windowMs: 86_400_000, onUnavailable: 'deny' }],
    ]);
  });

  it('refuses on the minute window without spending the day window', async () => {
    const { limiter, consume } = scriptedLimiter({
      min: { allowed: false, retryAfterMs: 12_300 },
    });

    expect(await consumeTokenRateLimit(limiter, tokenId, LIMITS)).toEqual({
      status: 'limited',
      retryAfterSeconds: 13,
    });
    expect(consume).toHaveBeenCalledTimes(1);
  });

  it('refuses on the day window with the time until it resets', async () => {
    const { limiter } = scriptedLimiter({ day: { allowed: false, retryAfterMs: 3_600_000 } });

    expect(await consumeTokenRateLimit(limiter, tokenId, LIMITS)).toEqual({
      status: 'limited',
      retryAfterSeconds: 3600,
    });
  });

  it('reports either window losing its store as unavailable, never as a spent window', async () => {
    const minute = scriptedLimiter({ min: STORE_DOWN });
    const day = scriptedLimiter({ day: STORE_DOWN });

    expect(await consumeTokenRateLimit(minute.limiter, tokenId, LIMITS)).toEqual({
      status: 'unavailable',
    });
    expect(minute.consume).toHaveBeenCalledTimes(1);
    expect(await consumeTokenRateLimit(day.limiter, tokenId, LIMITS)).toEqual({
      status: 'unavailable',
    });
  });

  it('refuses when the store is unreachable even if the limiter let the request through', async () => {
    const { limiter } = scriptedLimiter({ min: { ...ALLOWED, unavailable: true } });

    expect(await consumeTokenRateLimit(limiter, tokenId, LIMITS)).toEqual({
      status: 'unavailable',
    });
  });
});

describe('rateLimitRefused', () => {
  it('answers a spent window with 429 and its retry time', () => {
    const response = rateLimitRefused({ status: 'limited', retryAfterSeconds: 42 });

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('42');
  });

  it('answers a store it cannot reach with 503, retrying after 30 seconds', async () => {
    const response = rateLimitRefused({ status: 'unavailable' });

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('30');
    expect(await response.json()).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32000, message: 'Service unavailable' },
    });
  });
});

describe('error responses', () => {
  it.each([
    ['origin refused', originRefused, 403, -32000],
    ['method not allowed', methodNotAllowed, 405, -32000],
    ['bearer required', bearerRequired, 401, -32000],
    ['invalid token', invalidToken, 401, -32000],
    ['rate limited', () => rateLimited(5), 429, -32000],
    ['limiter unavailable', limiterUnavailable, 503, -32000],
    ['access denied', accessDenied, 403, -32000],
    ['payload too large', payloadTooLarge, 413, -32000],
    ['parse error', parseError, 400, -32700],
    ['batch refused', batchRefused, 400, -32600],
    ['internal error', internalError, 500, -32603],
  ])('answers %s as a no-store JSON-RPC error', async (_name, build, status, code) => {
    const response = build();

    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code, message: expect.any(String) },
    });
  });

  it('challenges a missing bearer with the bare scheme', () => {
    expect(bearerRequired().headers.get('www-authenticate')).toBe('Bearer');
  });

  it('challenges a refused token as invalid_token, naming no resource metadata', () => {
    expect(invalidToken().headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
  });

  it('names no challenge when the grant is missing', () => {
    expect(accessDenied().headers.get('www-authenticate')).toBeNull();
  });

  it('allows POST only', () => {
    expect(methodNotAllowed().headers.get('allow')).toBe('POST');
  });

  it('tells a limited client when to retry', () => {
    expect(rateLimited(42).headers.get('retry-after')).toBe('42');
  });
});

describe('preflight', () => {
  it('allows POST with the MCP request headers for that origin alone', () => {
    const response = preflight(BACKOFFICE);

    expect(response.status).toBe(204);
    expect(Object.fromEntries(response.headers)).toEqual({
      'access-control-allow-origin': BACKOFFICE,
      'access-control-allow-methods': 'POST',
      'access-control-allow-headers': 'authorization, content-type, accept, mcp-protocol-version',
      'cache-control': 'no-store',
      vary: 'Origin',
    });
  });
});

describe('noStore', () => {
  it('marks a copy no-store, keeping the status, body and other headers of the original', async () => {
    const original = new Response('{"ok":true}', {
      status: 202,
      headers: { 'Cache-Control': 'no-cache', 'X-Kept': '1' },
    });

    const copy = noStore(original);

    expect(copy.status).toBe(202);
    expect(copy.headers.get('cache-control')).toBe('no-store');
    expect(copy.headers.get('x-kept')).toBe('1');
    expect(original.headers.get('cache-control')).toBe('no-cache');
    expect(await copy.text()).toBe('{"ok":true}');
  });
});

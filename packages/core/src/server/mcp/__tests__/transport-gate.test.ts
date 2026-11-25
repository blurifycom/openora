import { describe, it } from 'vitest';

describe('parseBearer', () => {
  it.todo('returns the token from a well formed bearer header');
  it.todo('returns null for a missing header');
  it.todo('returns null for a header over the length cap');
  it.todo('returns null for a non-bearer scheme or an empty token');
});

describe('servesHost and originVerdict', () => {
  it.todo('matches a host case-insensitively against the allow-list');
  it.todo('refuses a host that is not listed');
  it.todo('a request without an Origin header is none');
  it.todo('a listed Origin is allowed');
  it.todo('an unlisted Origin is refused');
  it.todo('an empty allow-list refuses every request that carries an Origin');
});

describe('rate limits', () => {
  it.todo('an unknown client address is not limited');
  it.todo(
    'the address minute window refuses once the limit is spent and reports retry-after rounded up to at least 1 second',
  );
  it.todo('a token minute refusal does not count against the day window');
  it.todo('a token past its day limit is limited');
  it.todo('a limiter that is unavailable fails closed for the address window');
  it.todo('a limiter that is unavailable fails closed for the token windows');
});

describe('refusal responses', () => {
  it.todo('each refusal is a JSON-RPC error with no-store and the right status');
  it.todo('rate limit refusal carries a Retry-After header');
  it.todo('preflight answers only for the requesting origin');
  it.todo('withHeaders keeps the original body and status');
});

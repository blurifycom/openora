import { describe, it } from 'vitest';

describe('MCP transport gate', () => {
  it.todo('a request without a bearer token is refused with 401 and no-store');
  it.todo('a request with an invalid or revoked token is refused with 401');
  it.todo('a valid token calls a tool and gets a JSON-RPC result');
  it.todo('a request from an unlisted Origin is refused and a listed Origin gets CORS headers');
  it.todo('a non-POST method is refused with 405');
  it.todo('an oversized body is refused with 413 and a malformed body with a parse error');
  it.todo('a JSON-RPC batch is refused');
  it.todo(
    'a token past its per-minute limit gets 429 with Retry-After and a fresh token is unaffected',
  );
  it.todo('an address past its per-minute limit is refused even with a different valid token');
  it.todo('every request is refused with a limiter-unavailable error when the limiter is down');
  it.todo('a token without the permission for a tool gets access denied');
});

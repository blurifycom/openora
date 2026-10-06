import {
  RATE_LIMIT_KEYS,
  makeRateLimitKey,
  type McpTransportConfig,
  type RateLimitKey,
  type RateLimiterAdapter,
  type Uuid,
} from '@openora/core/contracts';

const MAX_AUTHORIZATION_HEADER_LENGTH = 512;
const BEARER_PATTERN = /^Bearer +([\w\-.~+/]+=*)$/i;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

const JSON_RPC_SERVER_ERROR = -32000;
const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_INTERNAL_ERROR = -32603;
const JSON_RPC_PARSE_ERROR = -32700;

const NO_STORE = { 'Cache-Control': 'no-store' };

export type OriginVerdict = 'none' | 'allowed' | 'refused';

export type TokenRateLimitVerdict =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

export function parseBearer(header: string | null) {
  if (header === null || header.length > MAX_AUTHORIZATION_HEADER_LENGTH) {
    return null;
  }
  return BEARER_PATTERN.exec(header)?.[1] ?? null;
}

/**
 * An empty allow-list serves every host; otherwise only an exact hostname match.
 */
export function servesHost(hostname: string, allowedHosts: readonly string[]) {
  return allowedHosts.length === 0 || allowedHosts.includes(hostname.toLowerCase());
}

/**
 * An empty allow-list refuses every request that carries an Origin header.
 */
export function originVerdict(
  origin: string | null,
  allowedOrigins: readonly string[],
): OriginVerdict {
  if (origin === null) {
    return 'none';
  }
  return allowedOrigins.includes(origin) ? 'allowed' : 'refused';
}

export function retryAfterSeconds(retryAfterMs: number) {
  return Math.max(1, Math.ceil(retryAfterMs / 1000));
}

/**
 * Consumes one request from the token's minute window, then from its day window. Both fail
 * closed when the limiter is unreachable; a request the minute window refuses does not count
 * against the day.
 */
export async function consumeTokenRateLimit(
  limiter: RateLimiterAdapter<RateLimitKey>,
  tokenId: Uuid,
  limits: McpTransportConfig['rateLimit'],
): Promise<TokenRateLimitVerdict> {
  const minute = await limiter.consume(
    makeRateLimitKey(RATE_LIMIT_KEYS.MCP_TOKEN_MINUTE, tokenId),
    { limit: limits.perMinute, windowMs: MINUTE_MS, onUnavailable: 'deny' },
  );
  if (!minute.allowed) {
    return { allowed: false, retryAfterSeconds: retryAfterSeconds(minute.retryAfterMs) };
  }
  const day = await limiter.consume(makeRateLimitKey(RATE_LIMIT_KEYS.MCP_TOKEN_DAY, tokenId), {
    limit: limits.perDay,
    windowMs: DAY_MS,
    onUnavailable: 'deny',
  });
  if (!day.allowed) {
    return { allowed: false, retryAfterSeconds: retryAfterSeconds(day.retryAfterMs) };
  }
  return { allowed: true };
}

function jsonRpcError(
  status: number,
  error: { code: number; message: string },
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', error, id: null }), {
    status,
    headers: { 'Content-Type': 'application/json', ...NO_STORE, ...headers },
  });
}

export function originRefused() {
  return jsonRpcError(403, {
    code: JSON_RPC_SERVER_ERROR,
    message: 'Forbidden: origin not allowed',
  });
}

export function methodNotAllowed() {
  return jsonRpcError(
    405,
    { code: JSON_RPC_SERVER_ERROR, message: 'Method not allowed' },
    { Allow: 'POST' },
  );
}

/**
 * No `resource_metadata` in the challenge: it would send an MCP client into OAuth discovery.
 */
export function bearerRequired() {
  return jsonRpcError(
    401,
    { code: JSON_RPC_SERVER_ERROR, message: 'Unauthorized: bearer token required' },
    { 'WWW-Authenticate': 'Bearer' },
  );
}

export function invalidToken() {
  return jsonRpcError(
    401,
    { code: JSON_RPC_SERVER_ERROR, message: 'Unauthorized: invalid token' },
    { 'WWW-Authenticate': 'Bearer error="invalid_token"' },
  );
}

export function rateLimited(retryAfter: number) {
  return jsonRpcError(
    429,
    { code: JSON_RPC_SERVER_ERROR, message: 'Too many requests' },
    { 'Retry-After': String(retryAfter) },
  );
}

/**
 * No WWW-Authenticate: the SDK client answers an `insufficient_scope` 403 by starting OAuth.
 */
export function accessDenied() {
  return jsonRpcError(403, {
    code: JSON_RPC_SERVER_ERROR,
    message: 'Forbidden: MCP access not granted',
  });
}

export function payloadTooLarge() {
  return jsonRpcError(413, { code: JSON_RPC_SERVER_ERROR, message: 'Payload too large' });
}

export function parseError() {
  return jsonRpcError(400, { code: JSON_RPC_PARSE_ERROR, message: 'Parse error: invalid JSON' });
}

export function batchRefused() {
  return jsonRpcError(400, {
    code: JSON_RPC_INVALID_REQUEST,
    message: 'Invalid Request: batch requests are not supported',
  });
}

export function internalError() {
  return jsonRpcError(500, { code: JSON_RPC_INTERNAL_ERROR, message: 'Internal error' });
}

export function corsHeaders(origin: string) {
  return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
}

export function preflight(origin: string) {
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(origin),
      'Access-Control-Allow-Methods': 'POST',
      'Access-Control-Allow-Headers': 'authorization, content-type, accept, mcp-protocol-version',
      ...NO_STORE,
    },
  });
}

export function withHeaders(response: Response, extra: Record<string, string>) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(extra)) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function noStore(response: Response) {
  return withHeaders(response, NO_STORE);
}

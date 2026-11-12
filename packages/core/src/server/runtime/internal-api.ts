import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Service-to-service request signing for the `/internal/v1` surface (ADR-0052). Every request
 * carries the caller's `SERVICE_NAME`, a unix-ms timestamp and an HMAC-SHA256 over
 * `service\ntimestamp\nMETHOD\npath+query\nsha256hex(body)` with a secret shared by the install.
 */
export const INTERNAL_API_PREFIX = '/internal/v1';

export const INTERNAL_API_HEADERS = {
  service: 'x-openora-service',
  timestamp: 'x-openora-timestamp',
  signature: 'x-openora-signature',
} as const;

export const INTERNAL_API_MAX_CLOCK_SKEW_MS = 60_000;

export const INTERNAL_API_MAX_BODY_BYTES = 1_048_576;

const MIN_SECRET_LENGTH = 32;
const SERVICE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TIMESTAMP_PATTERN = /^\d{1,15}$/;
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Parses `INTERNAL_API_SECRETS`: a comma-separated list, the first signs and every one verifies,
 * so a secret rotates by prepending the new one and dropping the old one once every service runs
 * with it. Unset or blank is `[]`: the internal API is off and refuses every request.
 */
export function parseInternalApiSecrets(raw: string | undefined): readonly string[] {
  const secrets = (raw ?? '')
    .split(',')
    .map((secret) => secret.trim())
    .filter(Boolean);
  if (secrets.some((secret) => secret.length < MIN_SECRET_LENGTH)) {
    throw new Error(
      `[create-app] INTERNAL_API_SECRETS: every secret must be at least ${MIN_SECRET_LENGTH} ` +
        'characters. Generate one with `openssl rand -hex 32`.',
    );
  }
  return secrets;
}

export type SignedRequest = {
  service: string;
  timestamp: string;
  method: string;
  pathAndQuery: string;
  body: Uint8Array;
};

export function signInternalRequest(request: SignedRequest, secret: string): string {
  const bodyHash = createHash('sha256').update(request.body).digest('hex');
  const canonical = [
    request.service,
    request.timestamp,
    request.method.toUpperCase(),
    request.pathAndQuery,
    bodyHash,
  ].join('\n');
  return createHmac('sha256', secret).update(canonical).digest('hex');
}

export type InternalRequest = {
  headers: Headers;
  method: string;
  pathAndQuery: string;
  body: Uint8Array;
};

/** The calling service's name when the request is signed by one of `secrets`, else `null`. */
export function verifyInternalRequest(
  request: InternalRequest,
  secrets: readonly string[],
  now: number,
): string | null {
  const service = request.headers.get(INTERNAL_API_HEADERS.service);
  const timestamp = request.headers.get(INTERNAL_API_HEADERS.timestamp);
  const signature = request.headers.get(INTERNAL_API_HEADERS.signature);
  if (
    secrets.length === 0 ||
    !service ||
    !SERVICE_NAME_PATTERN.test(service) ||
    !timestamp ||
    !TIMESTAMP_PATTERN.test(timestamp) ||
    Math.abs(now - Number(timestamp)) > INTERNAL_API_MAX_CLOCK_SKEW_MS ||
    !signature ||
    !SIGNATURE_PATTERN.test(signature)
  ) {
    return null;
  }
  const given = Buffer.from(signature, 'hex');
  const signed = { ...request, service, timestamp };
  // Every secret is tried, so the time taken does not tell which one matched.
  const matches = secrets.map((secret) =>
    timingSafeEqual(given, Buffer.from(signInternalRequest(signed, secret), 'hex')),
  );
  return matches.includes(true) ? service : null;
}

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const INTERNAL_API_PREFIX = '/internal/v1';

export const INTERNAL_API_HEADERS = {
  service: 'x-openora-service',
  timestamp: 'x-openora-timestamp',
  signature: 'x-openora-signature',
} as const;

const INTERNAL_API_MAX_CLOCK_SKEW_MS = 60_000;

export const INTERNAL_API_SESSION_HEADERS = [
  'cookie',
  'authorization',
  'proxy-authorization',
  'x-user-id',
  'x-username',
] as const;

const MIN_SECRET_LENGTH = 32;
const SERVICE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TIMESTAMP_PATTERN = /^\d{1,15}$/;
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/;

export function parseInternalApiSecrets(raw: string | undefined): readonly string[] {
  const secrets = (raw ?? '')
    .split(',')
    .map((secret) => secret.trim())
    .filter(Boolean);
  if (secrets.some((secret) => secret.length < MIN_SECRET_LENGTH)) {
    throw new Error(
      `INTERNAL_API_SECRETS: every secret must be at least ${MIN_SECRET_LENGTH} ` +
        'characters. Generate one with `openssl rand -hex 32`.',
    );
  }
  return secrets;
}

type SignedContent = {
  audience: string;
  method: string;
  pathAndQuery: string;
  contentType: string;
  body: Uint8Array;
};

export type SignedRequest = SignedContent & { service: string; timestamp: string };

export function signInternalRequest(request: SignedRequest, secret: string): string {
  const bodyHash = createHash('sha256').update(request.body).digest('hex');
  const canonical = [
    request.service,
    request.audience,
    request.timestamp,
    request.method.toUpperCase(),
    request.pathAndQuery,
    request.contentType,
    bodyHash,
  ].join('\n');
  return createHmac('sha256', secret).update(canonical).digest('hex');
}

export type InternalRefusalReason =
  | 'disabled'
  | 'missing_header'
  | 'malformed_header'
  | 'clock_skew'
  | 'body_too_large'
  | 'bad_signature';

type SignatureHeaders = { service: string; timestamp: string; signature: string };

export function readSignatureHeaders(
  headers: Headers,
  now: number,
): SignatureHeaders | InternalRefusalReason {
  const service = headers.get(INTERNAL_API_HEADERS.service);
  const timestamp = headers.get(INTERNAL_API_HEADERS.timestamp);
  const signature = headers.get(INTERNAL_API_HEADERS.signature);
  if (!service || !timestamp || !signature) {
    return 'missing_header';
  }
  if (
    !SERVICE_NAME_PATTERN.test(service) ||
    !TIMESTAMP_PATTERN.test(timestamp) ||
    !SIGNATURE_PATTERN.test(signature)
  ) {
    return 'malformed_header';
  }
  if (Math.abs(now - Number(timestamp)) > INTERNAL_API_MAX_CLOCK_SKEW_MS) {
    return 'clock_skew';
  }
  return { service, timestamp, signature };
}

export function isSignedBy(
  headers: SignatureHeaders,
  content: SignedContent,
  secrets: readonly string[],
): boolean {
  const given = Buffer.from(headers.signature, 'hex');
  const signed = { ...content, service: headers.service, timestamp: headers.timestamp };
  const matches = secrets.map((secret) => {
    const expected = Buffer.from(signInternalRequest(signed, secret), 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  return matches.includes(true);
}

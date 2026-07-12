import { createHmac, timingSafeEqual } from 'node:crypto';
import type { KycWebhookVerifier } from '@openora/core/contracts';

// Case-insensitive lookup - the runtime normally lowercases header names (Fetch `Headers`),
// but a caller passing raw framework headers may not.
function findHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  if (!key) {
    return null;
  }
  const raw = headers[key];
  return Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
}

/**
 * Default KYC-webhook verifier: recomputes an HMAC-SHA256 of the raw request body
 * keyed by the configured secret and constant-time compares the hex digest against
 * the `x-kyc-signature` header (a leading `sha256=` is tolerated). Fails closed when
 * the secret is unset, the signature is absent, or the body was not captured.
 */
export class HmacKycWebhookVerifier implements KycWebhookVerifier {
  constructor(private readonly secret: string | undefined) {}

  verify(rawBody: string, headers: Record<string, string | string[] | undefined>): boolean {
    const signature = findHeader(headers, 'x-kyc-signature');
    if (!this.secret || !signature) {
      return false;
    }
    const provided = signature.startsWith('sha256=')
      ? signature.slice('sha256='.length)
      : signature;
    const expected = createHmac('sha256', this.secret).update(rawBody, 'utf8').digest('hex');
    const expectedBuf = Buffer.from(expected, 'utf8');
    const providedBuf = Buffer.from(provided, 'utf8');
    if (expectedBuf.length !== providedBuf.length) {
      return false;
    }
    return timingSafeEqual(expectedBuf, providedBuf);
  }
}

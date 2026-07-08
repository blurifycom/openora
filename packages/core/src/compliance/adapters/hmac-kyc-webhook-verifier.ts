import { createHmac, timingSafeEqual } from 'node:crypto';
import type { KycWebhookVerifier } from '@openora/core/contracts';

/**
 * Default KYC-webhook verifier: recomputes an HMAC-SHA256 of the raw request body
 * keyed by the configured secret and constant-time compares the hex digest against
 * the signature header (a leading `sha256=` is tolerated). Fails closed when the
 * secret is unset, the signature is absent, or the body was not captured.
 */
export class HmacKycWebhookVerifier implements KycWebhookVerifier {
  constructor(private readonly secret: string | undefined) {}

  verify(rawBody: string, signature: string | null): boolean {
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

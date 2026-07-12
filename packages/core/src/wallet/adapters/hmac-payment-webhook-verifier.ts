import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PaymentWebhookVerifier } from '@openora/core/contracts';

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const lowerName = name.toLowerCase();
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === lowerName);
  const raw = match?.[1];
  return Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
}

/**
 * Default payment-webhook verifier: recomputes an HMAC-SHA256 of the raw request body
 * keyed by the configured secret and constant-time compares the hex digest against the
 * (case-insensitively looked-up) `x-payment-signature` header - a leading `sha256=` is
 * tolerated. Fails closed when the secret is unset, the signature is absent, or the
 * body was not captured.
 */
export class HmacPaymentWebhookVerifier implements PaymentWebhookVerifier {
  constructor(private readonly secret: string | undefined) {}

  verify(rawBody: string, headers: Record<string, string | string[] | undefined>): boolean {
    const signature = headerValue(headers, 'x-payment-signature');
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

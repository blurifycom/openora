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

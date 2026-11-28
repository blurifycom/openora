import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { CacheAdapter, KycWebhookVerifier } from '@openora/core/contracts';
import { createLogger } from '@openora/core/server';

const logger = createLogger('hmac-kyc-webhook-verifier');

function findHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  if (!key) {
    return null;
  }
  const raw = headers[key];
  return Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
}

const REPLAY_WINDOW_MS = 10 * 60 * 1000;
const REPLAY_CACHE_PREFIX = 'kyc-webhook-seen:';

export class HmacKycWebhookVerifier implements KycWebhookVerifier {
  constructor(
    private readonly secret: string | undefined,
    private readonly cache: CacheAdapter,
  ) {}

  async verify(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<boolean> {
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
    if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
      return false;
    }
    return this.acceptOnce(provided);
  }

  private async acceptOnce(signature: string): Promise<boolean> {
    const key = `${REPLAY_CACHE_PREFIX}${createHash('sha256').update(signature).digest('hex')}`;
    try {
      const seen = await this.cache.get<true>(key);
      if (seen) {
        return false;
      }
      await this.cache.set(key, true, { ttlMs: REPLAY_WINDOW_MS });
      return true;
    } catch (err) {
      logger.warn({ err }, 'kyc webhook replay-check cache unavailable - degrading open');
      return true;
    }
  }
}

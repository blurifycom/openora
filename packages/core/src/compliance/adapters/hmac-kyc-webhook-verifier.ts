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

// A captured, genuinely-valid (body, signature) pair never expires on its own - HMAC
// has no built-in freshness. Reject a signature we've already accepted within this
// window; only a matching duplicate landing INSIDE the window is ever rejected, which
// comfortably covers a vendor's own legitimate retry burst (eg Didit's ~5s/2 retries)
// while still closing most of the "resend a captured payload later" attack. Bounded,
// not infinite: a store that never forgets grows without limit, and every accepted
// decision beyond this window still passes through the compliance service's own
// idempotent DB-guard (KycVerificationService.reconcile) plus its decision-monotonicity
// check, which refuses to apply a decision older than the one already on file - genuine
// defense in depth for a replay that outlives this cache entry.
const REPLAY_WINDOW_MS = 10 * 60 * 1000;
const REPLAY_CACHE_PREFIX = 'kyc-webhook-seen:';

/**
 * Default KYC-webhook verifier: recomputes an HMAC-SHA256 of the raw request body
 * keyed by the configured secret and constant-time compares the hex digest against
 * the `x-kyc-signature` header (a leading `sha256=` is tolerated). Fails closed when
 * the secret is unset, the signature is absent, or the body was not captured.
 *
 * Also rejects a signature already seen within `REPLAY_WINDOW_MS`, via the `CACHE`
 * seam - the same port already bound cross-instance when `REDIS_URL` is set (ADR-0028),
 * so replay detection coordinates across replicas with zero extra wiring; the
 * in-process default degrades sensibly to per-instance-only protection. A vendor
 * (eg Didit) may sign only the body, never a timestamp, so a signed-timestamp
 * freshness check is not an option here - the signature itself is the only
 * authenticated, replay-detectable value. A `CACHE` failure degrades OPEN (logs and
 * treats the delivery as unseen) rather than blocking every webhook on an unrelated
 * infra blip - the signature check above remains the fail-closed primary control;
 * this is a secondary, best-effort layer.
 */
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

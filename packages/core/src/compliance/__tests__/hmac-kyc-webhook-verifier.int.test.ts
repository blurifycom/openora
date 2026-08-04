import { createHmac } from 'node:crypto';
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import type { CacheAdapter } from '@openora/core/contracts';
import { RedisCache } from '@openora/core/server';
import { createTestRedis, type TestRedis } from '@openora/core/testing';
import { HmacKycWebhookVerifier } from '../adapters/hmac-kyc-webhook-verifier.js';

let redis: TestRedis;

beforeAll(async () => {
  redis = await createTestRedis();
});

afterEach(async () => {
  await redis.flush();
});

afterAll(async () => {
  await redis.quit();
});

const SECRET = 'shh';
const BODY = '{"event":"decision"}';

function sign(body: string, secret = SECRET) {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

function makeCache(): CacheAdapter {
  return new RedisCache(redis.client);
}

function unavailableCache(): CacheAdapter {
  return {
    get: async () => {
      throw new Error('cache unavailable');
    },
    set: async () => {
      throw new Error('cache unavailable');
    },
    setIfAbsent: async () => {
      throw new Error('cache unavailable');
    },
    delete: async () => undefined,
  };
}

describe('HmacKycWebhookVerifier (fail closed)', () => {
  it('accepts a correct signature (with and without sha256= prefix)', async () => {
    const v = new HmacKycWebhookVerifier(SECRET, makeCache());
    await expect(v.verify(BODY, { 'x-kyc-signature': sign(BODY) })).resolves.toBe(true);

    const prefixedBody = '{"event":"decision-2"}';
    const v2 = new HmacKycWebhookVerifier(SECRET, makeCache());
    await expect(
      v2.verify(prefixedBody, { 'x-kyc-signature': `sha256=${sign(prefixedBody)}` }),
    ).resolves.toBe(true);
  });

  it('extracts the signature header case-insensitively', async () => {
    const v = new HmacKycWebhookVerifier(SECRET, makeCache());
    await expect(v.verify(BODY, { 'X-Kyc-Signature': sign(BODY) })).resolves.toBe(true);
  });

  it('rejects a wrong signature, a missing signature, and an unset secret', async () => {
    await expect(
      new HmacKycWebhookVerifier(SECRET, makeCache()).verify(BODY, {
        'x-kyc-signature': sign('tampered'),
      }),
    ).resolves.toBe(false);
    await expect(new HmacKycWebhookVerifier(SECRET, makeCache()).verify(BODY, {})).resolves.toBe(
      false,
    );
    await expect(
      new HmacKycWebhookVerifier(undefined, makeCache()).verify(BODY, {
        'x-kyc-signature': sign(BODY),
      }),
    ).resolves.toBe(false);
  });
});

describe('HmacKycWebhookVerifier replay protection', () => {
  it('rejects a second delivery carrying the same valid signature (a captured payload replayed later)', async () => {
    const cache = makeCache();
    const v = new HmacKycWebhookVerifier(SECRET, cache);
    const headers = { 'x-kyc-signature': sign(BODY) };

    await expect(v.verify(BODY, headers)).resolves.toBe(true);
    // Same verifier instance, same signature, later call - the exact "captured and
    // resent" attack this control exists for.
    await expect(v.verify(BODY, headers)).resolves.toBe(false);
  });

  it('does not cross-contaminate replay state between different signatures', async () => {
    const cache = makeCache();
    const v = new HmacKycWebhookVerifier(SECRET, cache);
    const otherBody = '{"event":"other-decision"}';

    await expect(v.verify(BODY, { 'x-kyc-signature': sign(BODY) })).resolves.toBe(true);
    await expect(v.verify(otherBody, { 'x-kyc-signature': sign(otherBody) })).resolves.toBe(true);
  });

  it('degrades open (accepts) when the replay-check cache is unavailable, rather than blocking every webhook', async () => {
    const v = new HmacKycWebhookVerifier(SECRET, unavailableCache());
    await expect(v.verify(BODY, { 'x-kyc-signature': sign(BODY) })).resolves.toBe(true);
  });
});

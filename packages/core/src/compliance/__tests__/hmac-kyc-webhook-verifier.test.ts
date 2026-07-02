import { createHmac } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { HmacKycWebhookVerifier } from '../adapters/hmac-kyc-webhook-verifier.js';

const SECRET = 'shh';
const BODY = '{"event":"decision"}';

function sign(body: string, secret = SECRET) {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

describe('HmacKycWebhookVerifier (fail closed)', () => {
  it('accepts a correct signature (with and without sha256= prefix)', () => {
    const v = new HmacKycWebhookVerifier(SECRET);
    expect(v.verify(BODY, sign(BODY))).toBe(true);
    expect(v.verify(BODY, `sha256=${sign(BODY)}`)).toBe(true);
  });

  it('rejects a wrong signature, a missing signature, and an unset secret', () => {
    expect(new HmacKycWebhookVerifier(SECRET).verify(BODY, sign('tampered'))).toBe(false);
    expect(new HmacKycWebhookVerifier(SECRET).verify(BODY, null)).toBe(false);
    expect(new HmacKycWebhookVerifier(undefined).verify(BODY, sign(BODY))).toBe(false);
  });
});

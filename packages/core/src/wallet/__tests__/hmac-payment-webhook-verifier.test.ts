import { createHmac } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { HmacPaymentWebhookVerifier } from '../adapters/hmac-payment-webhook-verifier.js';

const SECRET = 'shh';
const BODY = '{"event":"deposit"}';

function sign(body: string, secret = SECRET) {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

describe('HmacPaymentWebhookVerifier (fail closed)', () => {
  it('accepts a correct signature via a case-insensitive x-payment-signature lookup (with and without sha256= prefix)', () => {
    const v = new HmacPaymentWebhookVerifier(SECRET);
    expect(v.verify(BODY, { 'x-payment-signature': sign(BODY) })).toBe(true);
    expect(v.verify(BODY, { 'X-Payment-Signature': `sha256=${sign(BODY)}` })).toBe(true);
  });

  it('rejects a wrong signature, a missing signature header, and an unset secret', () => {
    expect(
      new HmacPaymentWebhookVerifier(SECRET).verify(BODY, {
        'x-payment-signature': sign('tampered'),
      }),
    ).toBe(false);
    expect(new HmacPaymentWebhookVerifier(SECRET).verify(BODY, {})).toBe(false);
    expect(
      new HmacPaymentWebhookVerifier(undefined).verify(BODY, {
        'x-payment-signature': sign(BODY),
      }),
    ).toBe(false);
  });

  it('rejects a signature whose length differs from the expected digest', () => {
    const v = new HmacPaymentWebhookVerifier(SECRET);
    const good = sign(BODY);
    expect(v.verify(BODY, { 'x-payment-signature': good.slice(0, -2) })).toBe(false);
    expect(v.verify(BODY, { 'x-payment-signature': `${good}00` })).toBe(false);
    expect(v.verify(BODY, { 'x-payment-signature': 'sha256=' })).toBe(false);
  });

  it('reads only x-payment-signature, ignoring other headers and taking the first array value', () => {
    const v = new HmacPaymentWebhookVerifier(SECRET);
    expect(v.verify(BODY, { 'x-other': sign(BODY) })).toBe(false);
    expect(v.verify(BODY, { 'x-other': 'junk', 'x-payment-signature': sign(BODY) })).toBe(true);
    expect(v.verify(BODY, { 'x-other': sign(BODY), 'x-payment-signature': 'junk' })).toBe(false);
    expect(v.verify(BODY, { 'x-payment-signature': [sign(BODY), 'junk'] })).toBe(true);
    expect(v.verify(BODY, { 'x-payment-signature': ['junk', sign(BODY)] })).toBe(false);
    expect(v.verify(BODY, { 'x-payment-signature': [] })).toBe(false);
    expect(v.verify(BODY, { 'x-payment-signature': '' })).toBe(false);
  });

  it('rejects a signature made with another secret or over another body, and an empty secret', () => {
    expect(
      new HmacPaymentWebhookVerifier(SECRET).verify(BODY, {
        'x-payment-signature': sign(BODY, 'other'),
      }),
    ).toBe(false);
    expect(
      new HmacPaymentWebhookVerifier('').verify(BODY, { 'x-payment-signature': sign(BODY, '') }),
    ).toBe(false);
  });
});

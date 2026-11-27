import { createHmac } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { HmacPaymentWebhookVerifier } from '../hmac-payment-webhook-verifier.js';

const SECRET = 'whsec_test_secret';
const BODY = '{"event":"deposit.completed","amount":"10.50"}';
const HEADER = 'x-payment-signature';

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

describe('HmacPaymentWebhookVerifier', () => {
  const verifier = new HmacPaymentWebhookVerifier(SECRET);

  it('accepts a valid bare hex signature', () => {
    expect(verifier.verify(BODY, { [HEADER]: sign(BODY, SECRET) })).toBe(true);
  });

  it('accepts a valid signature with the sha256= prefix', () => {
    expect(verifier.verify(BODY, { [HEADER]: `sha256=${sign(BODY, SECRET)}` })).toBe(true);
  });

  it('rejects a signature made with another secret', () => {
    expect(verifier.verify(BODY, { [HEADER]: sign(BODY, 'other') })).toBe(false);
  });

  it('rejects a signature over a different body', () => {
    expect(verifier.verify(BODY, { [HEADER]: sign(`${BODY} `, SECRET) })).toBe(false);
  });

  it('rejects a truncated signature and one with extra characters', () => {
    const good = sign(BODY, SECRET);
    expect(verifier.verify(BODY, { [HEADER]: good.slice(0, -1) })).toBe(false);
    expect(verifier.verify(BODY, { [HEADER]: `${good}0` })).toBe(false);
  });

  it('rejects a prefix with no digest', () => {
    expect(verifier.verify(BODY, { [HEADER]: 'sha256=' })).toBe(false);
  });

  it('rejects a missing, empty or undefined header', () => {
    expect(verifier.verify(BODY, {})).toBe(false);
    expect(verifier.verify(BODY, { [HEADER]: '' })).toBe(false);
    expect(verifier.verify(BODY, { [HEADER]: undefined })).toBe(false);
    expect(verifier.verify(BODY, { [HEADER]: [] })).toBe(false);
  });

  it('rejects everything when the secret is unset or empty', () => {
    expect(
      new HmacPaymentWebhookVerifier(undefined).verify(BODY, { [HEADER]: sign(BODY, '') }),
    ).toBe(false);
    expect(new HmacPaymentWebhookVerifier('').verify(BODY, { [HEADER]: sign(BODY, '') })).toBe(
      false,
    );
  });

  it('matches the header name case-insensitively', () => {
    const signature = sign(BODY, SECRET);
    expect(verifier.verify(BODY, { 'X-Payment-Signature': signature })).toBe(true);
    expect(verifier.verify(BODY, { 'X-PAYMENT-SIGNATURE': signature })).toBe(true);
  });

  it('ignores a differently named header', () => {
    expect(verifier.verify(BODY, { 'x-signature': sign(BODY, SECRET) })).toBe(false);
  });

  it('uses the first value of an array header only', () => {
    const good = sign(BODY, SECRET);
    expect(verifier.verify(BODY, { [HEADER]: [good, 'junk'] })).toBe(true);
    expect(verifier.verify(BODY, { [HEADER]: ['junk', good] })).toBe(false);
  });

  it('signs the utf8 bytes of a multibyte body', () => {
    const body = '{"note":"zażółć gęślą jaźń"}';
    expect(verifier.verify(body, { [HEADER]: sign(body, SECRET) })).toBe(true);
  });

  it('property: a signature verifies for any body and secret, and fails for any other body', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.string(),
        fc.string(),
        (secret, body, otherBody) => {
          const v = new HmacPaymentWebhookVerifier(secret);
          expect(v.verify(body, { [HEADER]: sign(body, secret) })).toBe(true);
          expect(v.verify(body, { [HEADER]: `sha256=${sign(body, secret)}` })).toBe(true);
          if (otherBody !== body) {
            expect(v.verify(otherBody, { [HEADER]: sign(body, secret) })).toBe(false);
          }
        },
      ),
    );
  });

  it('property: arbitrary header values never throw', () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        expect(typeof verifier.verify(BODY, { [HEADER]: value })).toBe('boolean');
      }),
    );
  });
});

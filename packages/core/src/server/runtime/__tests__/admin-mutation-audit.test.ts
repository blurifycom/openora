import { describe, it, expect } from 'vitest';
import { redactSecrets, storableInput } from '../admin-mutation-audit.js';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl';

describe('redactSecrets', () => {
  it.each([
    'password',
    'newPassword',
    'pass',
    'pwd',
    'clientSecret',
    'secret',
    'accessToken',
    'refresh_token',
    'idToken',
    'webhook_tokens',
    'apiKey',
    'api_key',
    'privateKey',
    'signingKey',
    'hmacKey',
    'secretKey',
    'otp',
    'totp',
    'code',
    'verificationCode',
    'twoFactorCode',
    'recoveryCodes',
    'pin',
    'cookie',
    'signature',
    'authorization',
    'Authorization',
  ])('masks %s', (key) => {
    expect(redactSecrets({ [key]: 'value' })).toEqual({ [key]: '[redacted]' });
  });

  it.each([
    'tokenAddress',
    'tokenId',
    'token_symbol',
    'pins',
    'pinnedIds',
    'countryCode',
    'currencyCode',
    'promoCode',
    'errorCode',
    'idempotencyKey',
    'sortKey',
    'publicKey',
    'footprint',
    'shipping',
    'spinCount',
    'opinion',
    'compass',
    'passed',
  ])('keeps %s', (key) => {
    expect(redactSecrets({ [key]: 'value' })).toEqual({ [key]: 'value' });
  });

  it('masks credential fields at any depth and inside arrays', () => {
    expect(
      redactSecrets({
        name: 'Hot wallet',
        provider: { clientSecret: 's', limit: 5 },
        rows: [{ otp: '123456', note: 'ok' }],
      }),
    ).toEqual({
      name: 'Hot wallet',
      provider: { clientSecret: '[redacted]', limit: 5 },
      rows: [{ otp: '[redacted]', note: 'ok' }],
    });
  });

  it('masks a string value shaped like a JWT or a URL with embedded credentials', () => {
    expect(
      redactSecrets({
        note: JWT,
        endpoint: 'https://user:hunter2@psp.example/hook',
        tokenUrl: 'https://token@psp.example/hook',
        homepage: 'https://psp.example/path',
        text: 'eyJ is not a token',
      }),
    ).toEqual({
      note: '[redacted]',
      endpoint: '[redacted]',
      tokenUrl: '[redacted]',
      homepage: 'https://psp.example/path',
      text: 'eyJ is not a token',
    });
  });

  it('returns non-object inputs as they are', () => {
    const when = new Date(0);
    expect(redactSecrets(undefined)).toBeUndefined();
    expect(redactSecrets('text')).toBe('text');
    expect(redactSecrets(when)).toBe(when);
  });
});

describe('storableInput', () => {
  it('keeps a small input redacted', () => {
    expect(storableInput({ id: 'a', password: 'x' })).toEqual({ id: 'a', password: '[redacted]' });
  });

  it('replaces an oversized input with a marker carrying its byte count', () => {
    const marker = storableInput({ note: 'x'.repeat(5000) });

    expect(marker).toEqual({ truncated: true, bytes: expect.any(Number) });
    expect((marker as { bytes: number }).bytes).toBeGreaterThan(5000);
  });

  it('marks an input that cannot be serialized', () => {
    expect(storableInput({ amount: 10n })).toEqual({ truncated: true });
  });
});

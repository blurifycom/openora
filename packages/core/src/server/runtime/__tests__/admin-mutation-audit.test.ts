import { describe, it, expect } from 'vitest';
import { redactSecrets } from '../admin-mutation-audit.js';

describe('redactSecrets', () => {
  it('masks credential-like fields at any depth and inside arrays', () => {
    expect(
      redactSecrets({
        name: 'Hot wallet',
        password: 'hunter2',
        apiKey: 'ak_live',
        api_key: 'ak_live',
        provider: { clientSecret: 's', accessToken: 't', limit: 5 },
        rows: [{ otp: '123456', pin: '0000', note: 'ok' }],
        webhook_tokens: ['a', 'b'],
      }),
    ).toEqual({
      name: 'Hot wallet',
      password: '[redacted]',
      apiKey: '[redacted]',
      api_key: '[redacted]',
      provider: { clientSecret: '[redacted]', accessToken: '[redacted]', limit: 5 },
      rows: [{ otp: '[redacted]', pin: '[redacted]', note: 'ok' }],
      webhook_tokens: '[redacted]',
    });
  });

  it('keeps fields that only contain a secret word inside another word', () => {
    const input = { footprint: 'x', shipping: 'y', spinCount: 3, opinion: 'z' };
    expect(redactSecrets(input)).toEqual(input);
  });

  it('returns non-object inputs as they are', () => {
    const when = new Date(0);
    expect(redactSecrets(undefined)).toBeUndefined();
    expect(redactSecrets('text')).toBe('text');
    expect(redactSecrets(when)).toBe(when);
  });
});

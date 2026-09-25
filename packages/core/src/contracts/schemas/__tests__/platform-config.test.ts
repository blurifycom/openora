import { describe, expect, it } from 'vitest';
import { definePlatformConfig, resolveWalletDefaultCurrency } from '../platform-config.js';

describe('resolveWalletDefaultCurrency', () => {
  it('falls back to USD when the operator has not set one', () => {
    expect(resolveWalletDefaultCurrency(undefined)).toBe('USD');
    expect(resolveWalletDefaultCurrency({})).toBe('USD');
  });

  it('uppercases the operator-configured currency', () => {
    expect(resolveWalletDefaultCurrency({ defaultCurrency: 'usdt' })).toBe('USDT');
  });
});

describe('definePlatformConfig', () => {
  it('canonicalizes attachment hosts before services consume the config', () => {
    const config = definePlatformConfig({
      chat: { allowedAttachmentHosts: ['MEDIA.EXAMPLE.COM'] },
    });

    expect(config.chat.allowedAttachmentHosts).toEqual(['media.example.com']);
  });

  it('rejects attachment hosts that include URL components', () => {
    expect(() =>
      definePlatformConfig({
        chat: { allowedAttachmentHosts: ['https://media.example.com/path'] },
      }),
    ).toThrow(/chat\.allowedAttachmentHosts\.0/);
  });
});

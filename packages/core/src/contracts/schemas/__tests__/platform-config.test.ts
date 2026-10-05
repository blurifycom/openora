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

  it('defaults gaming.allowedThumbnailHosts to an empty list (deny every custom thumbnail)', () => {
    const config = definePlatformConfig({});

    expect(config.gaming).toEqual({ allowedThumbnailHosts: [] });
  });

  it('canonicalizes gaming thumbnail hosts before services consume the config', () => {
    const config = definePlatformConfig({
      gaming: { allowedThumbnailHosts: ['CDN.EXAMPLE.COM'] },
    });

    expect(config.gaming.allowedThumbnailHosts).toEqual(['cdn.example.com']);
  });

  it('rejects gaming thumbnail hosts that include URL components', () => {
    expect(() =>
      definePlatformConfig({
        gaming: { allowedThumbnailHosts: ['https://cdn.example.com/path'] },
      }),
    ).toThrow(/gaming\.allowedThumbnailHosts\.0/);
  });
});

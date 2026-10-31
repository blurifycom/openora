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

  it('defaults both avatar allowlists to empty lists (deny every avatar URL)', () => {
    expect(definePlatformConfig({}).identity).toEqual({
      allowedAvatarHosts: [],
      allowedAvatarUrlPrefixes: [],
    });
  });

  it('canonicalizes avatar URL prefixes and rejects one without a trailing slash', () => {
    expect(
      definePlatformConfig({
        identity: { allowedAvatarUrlPrefixes: ['HTTPS://Play.Example.com/avatars/'] },
      }).identity.allowedAvatarUrlPrefixes,
    ).toEqual(['https://play.example.com/avatars/']);
    expect(() =>
      definePlatformConfig({
        identity: { allowedAvatarUrlPrefixes: ['https://play.example.com/avatars'] },
      }),
    ).toThrow(/identity\.allowedAvatarUrlPrefixes\.0/);
  });

  it('canonicalizes avatar hosts and rejects ones that include URL components', () => {
    expect(
      definePlatformConfig({ identity: { allowedAvatarHosts: ['AVATARS.EXAMPLE.COM'] } }).identity
        .allowedAvatarHosts,
    ).toEqual(['avatars.example.com']);
    expect(() =>
      definePlatformConfig({
        identity: { allowedAvatarHosts: ['https://avatars.example.com/path'] },
      }),
    ).toThrow(/identity\.allowedAvatarHosts\.0/);
  });

  it('rejects a significant-amount threshold set twice for one currency, ignoring case', () => {
    expect(() =>
      definePlatformConfig({
        wallet: { significantAmountThresholds: { USD: '1000000', usd: '1' } },
      }),
    ).toThrow(/significantAmountThresholds/);
  });
});

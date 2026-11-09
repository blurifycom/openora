import { describe, expect, it } from 'vitest';
import {
  definePlatformConfig,
  resolveMinPlayerAge,
  resolveWalletDefaultCurrency,
  type PlatformConfig,
} from '../platform-config.js';

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

describe('registration.minPlayerAge', () => {
  it('defaults to 18, also when registration is not configured', () => {
    expect(
      definePlatformConfig({ registration: { termsVersion: 'v1' } }).registration?.minPlayerAge,
    ).toBe(18);
    expect(resolveMinPlayerAge(definePlatformConfig({}))).toBe(18);
  });

  it('accepts an age above 18', () => {
    const config = definePlatformConfig({ registration: { termsVersion: 'v1', minPlayerAge: 21 } });

    expect(resolveMinPlayerAge(config)).toBe(21);
  });

  it('refuses an age below 18', () => {
    expect(() =>
      definePlatformConfig({ registration: { termsVersion: 'v1', minPlayerAge: 17 } }),
    ).toThrow(/registration\.minPlayerAge/);
  });

  it('never resolves below 18 for a config built without the schema', () => {
    const config = { registration: { termsVersion: 'v1', minPlayerAge: 16 } } as PlatformConfig;

    expect(resolveMinPlayerAge(config)).toBe(18);
  });
});

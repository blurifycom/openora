import { describe, it, expect } from 'vitest';
import { defineIgamingConfig } from '../igaming-config.js';

const MINIMAL = {
  branding: { name: 'Casino' },
  currencies: ['USD'],
  jurisdictions: ['MT'],
};

describe('defineIgamingConfig', () => {
  it('accepts a minimal config', () => {
    expect(defineIgamingConfig(MINIMAL)).toMatchObject({ currencies: ['USD'] });
  });

  it('fills the optional collections with empty defaults', () => {
    const cfg = defineIgamingConfig(MINIMAL);

    expect(cfg.blockedCountries).toEqual([]);
    expect(cfg.limits).toEqual({});
    expect(cfg.providers).toEqual({});
  });

  it('requires at least one currency - there is no implicit default', () => {
    expect(() => defineIgamingConfig({ ...MINIMAL, currencies: [] })).toThrow(/currencies/);
  });

  it('requires at least one jurisdiction', () => {
    expect(() => defineIgamingConfig({ ...MINIMAL, jurisdictions: [] })).toThrow(/jurisdictions/);
  });

  it('refuses to both license and geo-block the same country', () => {
    expect(() =>
      defineIgamingConfig({ ...MINIMAL, jurisdictions: ['MT'], blockedCountries: ['MT'] }),
    ).toThrow(/cannot also be in blockedCountries/);
  });

  it('rejects an unknown top-level key rather than silently dropping it', () => {
    expect(() => defineIgamingConfig({ ...MINIMAL, currency: 'USD' } as never)).toThrow(
      /Invalid igaming config/,
    );
  });

  it('names the offending path so the failure is actionable at boot', () => {
    expect(() => defineIgamingConfig({ ...MINIMAL, branding: { name: '' } })).toThrow(
      /branding\.name/,
    );
  });

  it('returns a parsed copy rather than the caller object', () => {
    const input = { ...MINIMAL };

    expect(defineIgamingConfig(input)).not.toBe(input);
  });
});

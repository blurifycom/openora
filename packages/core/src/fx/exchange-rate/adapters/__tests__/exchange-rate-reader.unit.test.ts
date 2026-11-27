import { describe, expect, it } from 'vitest';
import type { ExchangeRateProvider } from '@openora/core/contracts';
import { selectProvider } from '../exchange-rate-reader.service.js';

const provider = (): ExchangeRateProvider => ({ getRate: () => Promise.resolve(null) });

const crypto = provider();
const fiat = provider();

describe('selectProvider', () => {
  it.each([
    ['BTC', crypto],
    ['btc', crypto],
    ['Usdt', crypto],
    ['ETH', crypto],
    ['USD', fiat],
    ['EUR', fiat],
    ['', fiat],
    ['BTC ', fiat],
  ])('sends %j to the matching rail', (currency, expected) => {
    expect(selectProvider(currency, crypto, fiat)).toBe(expected);
  });

  it('reads the rail from the configured crypto list over the default', () => {
    expect(selectProvider('SOL', crypto, fiat, ['sol'])).toBe(crypto);
    expect(selectProvider('BTC', crypto, fiat, ['SOL'])).toBe(fiat);
  });

  it('treats every code as fiat when the configured crypto list is empty', () => {
    expect(selectProvider('BTC', crypto, fiat, [])).toBe(fiat);
  });

  it('returns no provider for a rail without one instead of falling back to the other', () => {
    expect(selectProvider('BTC', undefined, fiat)).toBeUndefined();
    expect(selectProvider('USD', crypto, undefined)).toBeUndefined();
  });
});

import { describe, it, expect } from 'vitest';
import type { ExchangeRateProvider } from '@openora/core/contracts';
import { mock } from '../../../testing/mock.js';
import { selectProvider } from '../service/exchange-rate-refresh.service.js';

const cryptoProvider = mock<ExchangeRateProvider>({});
const fiatProvider = mock<ExchangeRateProvider>({});

describe('selectProvider', () => {
  it('routes a crypto currency to the crypto provider via railFor', () => {
    expect(selectProvider('BTC', cryptoProvider, fiatProvider)).toBe(cryptoProvider);
  });

  it('routes a fiat currency to the fiat provider via railFor', () => {
    expect(selectProvider('EUR', cryptoProvider, fiatProvider)).toBe(fiatProvider);
  });

  it('returns undefined when the rail has no provider bound', () => {
    expect(selectProvider('BTC', undefined, fiatProvider)).toBeUndefined();
    expect(selectProvider('EUR', cryptoProvider, undefined)).toBeUndefined();
  });

  it('returns undefined when neither provider is bound', () => {
    expect(selectProvider('BTC', undefined, undefined)).toBeUndefined();
    expect(selectProvider('EUR', undefined, undefined)).toBeUndefined();
  });

  it('respects a custom crypto-currency override list, same as railFor', () => {
    expect(selectProvider('SOL', cryptoProvider, fiatProvider, ['SOL'])).toBe(cryptoProvider);
    expect(selectProvider('BTC', cryptoProvider, fiatProvider, ['SOL'])).toBe(fiatProvider);
  });
});

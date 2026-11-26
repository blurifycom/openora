import { describe, expect, it, vi } from 'vitest';
import type { ExchangeRateReader } from '@openora/core/contracts';
import {
  ExchangeRateService,
  UnsupportedExchangeCurrencyError,
} from '../service/exchange-rate.service.js';

const quote = (rate: string) => ({ rate, asOf: '2026-11-26T00:00:00.000Z' });

const setup = () => {
  const getRate = vi.fn((from: string, to: string) => Promise.resolve(quote(`${from}>${to}`)));
  const reader: ExchangeRateReader = { getRate, convert: () => Promise.resolve(null) };
  return { getRate, service: new ExchangeRateService(reader, ['usd', 'EUR', 'btc']) };
};

describe('ExchangeRateService', () => {
  it('refuses a source or target currency the operator does not offer without calling the reader', async () => {
    const { getRate, service } = setup();
    expect(() => service.getRate('DOGE', 'USD')).toThrow(UnsupportedExchangeCurrencyError);
    expect(() => service.getRate('USD', 'DOGE')).toThrow(UnsupportedExchangeCurrencyError);
    expect(getRate).not.toHaveBeenCalled();
    await expect(service.getRate('USD', 'EUR')).resolves.toEqual(quote('USD>EUR'));
    expect(getRate).toHaveBeenCalledTimes(1);
  });

  it('checks currencies case-insensitively', async () => {
    const { getRate, service } = setup();
    await expect(service.getRate('Usd', 'eur')).resolves.toEqual(quote('Usd>eur'));
    await expect(service.getRates('BTC', ['usd'])).resolves.toEqual([
      { from: 'usd', quote: quote('usd>BTC') },
    ]);
    expect(getRate).toHaveBeenCalledTimes(2);
  });

  it('answers a batch with a null quote for an unsupported source currency instead of failing the batch', async () => {
    const { getRate, service } = setup();
    const result = await service.getRates('USD', ['EUR', 'DOGE', 'BTC']);
    expect(result).toEqual([
      { from: 'EUR', quote: quote('EUR>USD') },
      { from: 'DOGE', quote: null },
      { from: 'BTC', quote: quote('BTC>USD') },
    ]);
    expect(getRate).toHaveBeenCalledTimes(2);
  });

  it('refuses a batch whose target currency is unsupported', () => {
    const { getRate, service } = setup();
    expect(() => service.getRates('DOGE', ['USD'])).toThrow(UnsupportedExchangeCurrencyError);
    expect(getRate).not.toHaveBeenCalled();
  });

  it('answers a batch in the order of the requested currencies', async () => {
    const delays: Record<string, number> = { EUR: 20, USD: 0, BTC: 10 };
    const reader: ExchangeRateReader = {
      getRate: async (from, to) => {
        await new Promise((resolve) => setTimeout(resolve, delays[from] ?? 0));
        return quote(`${from}>${to}`);
      },
      convert: () => Promise.resolve(null),
    };
    const slow = new ExchangeRateService(reader, ['usd', 'eur', 'btc']);
    const result = await slow.getRates('BTC', ['EUR', 'USD', 'BTC']);
    expect(result.map((entry) => entry.from)).toEqual(['EUR', 'USD', 'BTC']);
  });
});

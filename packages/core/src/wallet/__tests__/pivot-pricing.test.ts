import { describe, it, expect } from 'vitest';
import { makeExchangeRateReader } from '../../testing/mock.js';
import { pricedInPivot, withQuoteCache } from '../service/pivot-pricing.service.js';

describe('pricedInPivot', () => {
  it('sums every currency in the pivot and needs no rate for a zero total', async () => {
    const rates = makeExchangeRateReader('2');

    const total = await pricedInPivot(
      [
        { currency: 'usd', total: '10' },
        { currency: 'EUR', total: '5' },
        { currency: 'BTC', total: '0' },
        { currency: 'ETH', total: null },
      ],
      'USD',
      rates,
    );

    expect(total).toBe('20.000000000000000000');
    expect(rates.convert).toHaveBeenCalledTimes(1);
  });

  it('is unknown when a non-zero currency cannot be priced', async () => {
    expect(await pricedInPivot([{ currency: 'EUR', total: '5' }], 'USD', undefined)).toBeNull();
  });
});

describe('withQuoteCache', () => {
  it('asks the reader for each currency pair once and converts at that quote', async () => {
    const rates = makeExchangeRateReader('3');
    const cached = withQuoteCache(rates);

    const converted = await Promise.all([
      cached.convert('2', 'EUR', 'USD'),
      cached.convert('4', 'eur', 'usd'),
      cached.convert('1', 'BTC', 'USD'),
    ]);

    expect(converted).toEqual([
      '6.000000000000000000',
      '12.000000000000000000',
      '3.000000000000000000',
    ]);
    expect(rates.getRate).toHaveBeenCalledTimes(2);
  });
});

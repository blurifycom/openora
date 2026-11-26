import { describe, expect, it } from 'vitest';
import type { ExchangeRateReader } from '@openora/core/contracts';
import { ExchangeRateService, UnsupportedExchangeCurrencyError } from '../exchange-rate.service.js';

const QUOTE = { rate: '1.25', asOf: '2026-03-01T00:00:00.000Z' };

const recordingReader = () => {
  const calls: [string, string][] = [];
  const reader: ExchangeRateReader = {
    getRate: (from, to) => {
      calls.push([from, to]);
      return Promise.resolve(QUOTE);
    },
    convert: () => Promise.reject(new Error('convert is not part of the currency gate')),
  };
  return { reader, calls };
};

describe('ExchangeRateService currency gate', () => {
  it.each([
    ['USD', 'EUR'],
    ['usd', 'eur'],
    ['Btc', 'USD'],
  ])('reads %s to %s for configured codes in any case', async (from, to) => {
    const { reader, calls } = recordingReader();
    const service = new ExchangeRateService(reader, ['USD', 'eur', 'BTC']);
    await expect(service.getRate(from, to)).resolves.toEqual(QUOTE);
    expect(calls).toEqual([[from, to]]);
  });

  it.each([
    ['an unknown source', 'XYZ', 'USD'],
    ['an unknown target', 'USD', 'XYZ'],
    ['an empty code', '', 'USD'],
    ['a padded code', ' USD', 'EUR'],
    ['a cyrillic lookalike', 'UЅD', 'EUR'],
  ])('refuses %s without calling the reader', (_name, from, to) => {
    const { reader, calls } = recordingReader();
    const service = new ExchangeRateService(reader, ['USD', 'EUR']);
    expect(() => service.getRate(from, to)).toThrow(UnsupportedExchangeCurrencyError);
    expect(calls).toEqual([]);
  });

  it('refuses everything when no currency is configured', () => {
    const { reader } = recordingReader();
    expect(() => new ExchangeRateService(reader, []).getRate('USD', 'USD')).toThrow(
      UnsupportedExchangeCurrencyError,
    );
  });

  it('answers an unknown source with a null quote in a batch and reads only known ones', async () => {
    const { reader, calls } = recordingReader();
    const service = new ExchangeRateService(reader, ['USD', 'EUR', 'BTC']);
    await expect(service.getRates('USD', ['BTC', 'XYZ', 'eur'])).resolves.toEqual([
      { from: 'BTC', quote: QUOTE },
      { from: 'XYZ', quote: null },
      { from: 'eur', quote: QUOTE },
    ]);
    expect(calls).toEqual([
      ['BTC', 'USD'],
      ['eur', 'USD'],
    ]);
  });

  it('refuses a batch to an unknown target before reading anything', () => {
    const { reader, calls } = recordingReader();
    const service = new ExchangeRateService(reader, ['USD']);
    expect(() => service.getRates('XYZ', ['USD'])).toThrow(UnsupportedExchangeCurrencyError);
    expect(calls).toEqual([]);
  });
});

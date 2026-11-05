import { describe, it, expect } from 'vitest';
import { totalsPerCurrency } from '../service/financial-analytics.service.js';

describe('totalsPerCurrency', () => {
  it('folds the rails of a currency together and keeps every currency apart', () => {
    const totals = totalsPerCurrency({
      deposits: [
        { currency: 'USDT', rail: 'crypto', total: '100.5' },
        { currency: 'USDT', rail: 'fiat', total: '20' },
        { currency: 'EUR', rail: null, total: '7' },
      ],
      withdrawals: [{ currency: 'USDT', rail: 'crypto', total: '40' }],
      netDeposits: [
        { currency: 'USDT', total: '75.5' },
        { currency: 'EUR', total: '7' },
        { currency: 'BTC', total: '-0.5' },
      ],
      ggr: [
        { currency: 'USDT', total: '12' },
        { currency: 'EUR', total: '0' },
        { currency: 'BTC', total: '-1' },
      ],
      bonusCost: [
        { currency: 'USDT', total: '5' },
        { currency: 'EUR', total: '0' },
        { currency: 'BTC', total: '0.5' },
      ],
      ngr: [
        { currency: 'USDT', total: '7' },
        { currency: 'EUR', total: '0' },
        { currency: 'BTC', total: '-1.5' },
      ],
    });

    expect(totals).toEqual([
      {
        currency: 'BTC',
        deposits: '0',
        withdrawals: '0',
        netDeposits: '-0.5',
        ggr: '-1',
        bonusCost: '0.5',
        ngr: '-1.5',
      },
      {
        currency: 'EUR',
        deposits: '7.000000000000000000',
        withdrawals: '0',
        netDeposits: '7',
        ggr: '0',
        bonusCost: '0',
        ngr: '0',
      },
      {
        currency: 'USDT',
        deposits: '120.500000000000000000',
        withdrawals: '40.000000000000000000',
        netDeposits: '75.5',
        ggr: '12',
        bonusCost: '5',
        ngr: '7',
      },
    ]);
  });

  it('answers no currency for an empty summary', () => {
    expect(
      totalsPerCurrency({
        deposits: [],
        withdrawals: [],
        netDeposits: [],
        ggr: [],
        bonusCost: [],
        ngr: [],
      }),
    ).toEqual([]);
  });
});

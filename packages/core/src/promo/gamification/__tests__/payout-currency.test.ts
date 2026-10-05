import { describe, it, expect, vi } from 'vitest';
import type { ExchangeRateReader } from '@openora/core/contracts';
import { mock } from '../../../testing/mock.js';
import { priceForPayout } from '../shared/payout-currency.js';

const convert = vi.fn<ExchangeRateReader['convert']>();
const rates = mock<ExchangeRateReader>({ convert });

describe('pricing a payout into the operator payout currency', () => {
  it('skips the rate lookup entirely when the source is already the payout currency', async () => {
    const priced = await priceForPayout(rates, '50', 'USD', 'USD');

    expect(priced).toEqual({ amount: '50', currency: 'USD' });
    expect(convert).not.toHaveBeenCalled();
  });

  it('converts at the current rate when the source differs from the payout currency', async () => {
    convert.mockResolvedValue('48');

    const priced = await priceForPayout(rates, '50', 'USD', 'USDT');

    expect(convert).toHaveBeenCalledWith('50', 'USD', 'USDT');
    expect(priced).toEqual({ amount: '48', currency: 'USDT' });
  });

  it('throws rather than falling back to the source currency when no rate is available', async () => {
    convert.mockResolvedValue(null);

    await expect(priceForPayout(rates, '50', 'USD', 'USDT')).rejects.toThrow(
      'no exchange rate from USD to USDT',
    );
  });
});

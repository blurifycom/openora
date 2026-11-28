import type { ExchangeRateReader } from '@openora/core/contracts';
import { createDomainError } from '@openora/core/server';

export const PayoutRateUnavailableError = createDomainError<[from: string, to: string]>(
  'PayoutRateUnavailableError',
  (from, to) => `no exchange rate from ${from} to ${to} - retry once available`,
);

export async function priceForPayout(
  tx: unknown,
  rates: ExchangeRateReader,
  amount: string,
  currency: string,
  payoutCurrency: string,
): Promise<{ amount: string; currency: string }> {
  if (currency === payoutCurrency) {
    return { amount, currency };
  }
  const converted = await rates.convert(amount, currency, payoutCurrency, tx);
  if (converted === null) {
    throw new PayoutRateUnavailableError(currency, payoutCurrency);
  }
  return { amount: converted, currency: payoutCurrency };
}

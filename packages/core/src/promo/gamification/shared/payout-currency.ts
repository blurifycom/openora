import type { ExchangeRateReader } from '@openora/core/contracts';

/**
 * Prices a cash prize or cashback credit into the operator's payout currency - `RankPayoutService`
 * already does this per-player-currency dance for grants; a race prize, a rank challenge tier, and
 * a streak milestone's `cash` reward are all priced in whatever currency their own config carries
 * (a ladder, a tier, a milestone), which need not be a currency the player's wallet holds. Crediting
 * that source currency unconditionally would open a balance for it on a wallet that otherwise never
 * sees one.
 *
 * Same currency skips the rate lookup entirely, the same short-circuit `RankPayoutService.
 * inPayoutCurrency` takes. No rate throws rather than falling back to the source currency: a
 * missing rate is a transient vendor condition, and crediting the wrong currency to "make progress"
 * would be the defect this function exists to close. The caller's own settlement transaction is
 * expected to roll back on the throw, so the job's next tick retries the whole thing once a rate is
 * available - see `handleDeposit` in the compliance module for the same "skip and let a later run
 * retry" idiom.
 */
export async function priceForPayout(
  rates: ExchangeRateReader,
  amount: string,
  currency: string,
  payoutCurrency: string,
): Promise<{ amount: string; currency: string }> {
  if (currency === payoutCurrency) {
    return { amount, currency };
  }
  const converted = await rates.convert(amount, currency, payoutCurrency);
  if (converted === null) {
    throw new Error(
      `no exchange rate from ${currency} to ${payoutCurrency} - retry once available`,
    );
  }
  return { amount: converted, currency: payoutCurrency };
}

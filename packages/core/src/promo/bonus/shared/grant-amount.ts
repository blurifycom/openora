import { moneyCompare, moneyDivide, moneyScaleBy } from '@openora/core/server';

/**
 * What a deposit earns: the match, capped. Truncating, so a cap of 1000 on a 100 percent match
 * of 1000.000000000000000001 grants 1000 rather than a hundredth of a unit more.
 */
export function grantAmountFor(
  deposit: string,
  matchPercent: string,
  maxGrantAmount: string,
): string {
  const matched = moneyDivide(moneyScaleBy(deposit, matchPercent), '100');
  return moneyCompare(matched, maxGrantAmount) > 0 ? maxGrantAmount : matched;
}

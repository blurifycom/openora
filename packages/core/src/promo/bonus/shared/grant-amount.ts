import { moneyMin, moneyDivide, moneyScaleBy } from '@openora/core/server';

export function grantAmountFor(
  deposit: string,
  matchPercent: string,
  maxGrantAmount: string,
): string {
  const matched = moneyDivide(moneyScaleBy(deposit, matchPercent), '100');
  return moneyMin(matched, maxGrantAmount);
}

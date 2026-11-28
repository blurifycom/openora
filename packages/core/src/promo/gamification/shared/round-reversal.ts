import { moneyCompare, moneyDivide, moneyScaleBy } from '@openora/core/server';

type RoundContribution = { stake: string; wagered: string };

export function roundReversal(
  contribution: RoundContribution,
  reversedStake: string,
): RoundContribution {
  if (moneyCompare(reversedStake, contribution.stake) >= 0) {
    return contribution;
  }
  return {
    stake: reversedStake,
    wagered: moneyDivide(moneyScaleBy(contribution.wagered, reversedStake), contribution.stake),
  };
}

import { moneyCompare, moneyDivide, moneyScaleBy } from '@openora/core/server';

type RoundContribution = { stake: string; wagered: string };

/**
 * What a rollback of `reversedStake` takes back from one round's standing contribution: the
 * reversed stake capped at what still stands, and the counted amount in proportion to it. Taken
 * in proportion rather than re-converted, so a rate that moved since the bet can neither leave
 * part of a voided stake counted nor take back more than the round ever added.
 */
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

import { moneyCompare, moneyMax, moneyMin, moneyScaleBy } from '@openora/core/server';

type MaxBetTerms = {
  maxBet?: string | null;
  maxBetRate?: string | null;
  maxBetFloor?: string | null;
  maxBetCeiling?: string | null;
};

export function resolveMaxBet(grantedAmount: string, terms: MaxBetTerms): string | null {
  const { maxBetRate, maxBetFloor, maxBetCeiling } = terms;
  if (maxBetRate === null || maxBetRate === undefined) {
    return terms.maxBet ?? null;
  }
  const rated = moneyScaleBy(grantedAmount, maxBetRate);
  const floored =
    maxBetFloor === null || maxBetFloor === undefined ? rated : moneyMax(rated, maxBetFloor);
  return maxBetCeiling === null || maxBetCeiling === undefined
    ? floored
    : moneyMin(floored, maxBetCeiling);
}

/** The ways a terms object contradicts itself about its max bet; empty when it is coherent. */
export function maxBetTermsIssues(terms: MaxBetTerms): string[] {
  const issues: string[] = [];
  const { maxBet, maxBetRate, maxBetFloor, maxBetCeiling } = terms;
  if (maxBetRate !== null && maxBetRate !== undefined && maxBet !== null && maxBet !== undefined) {
    issues.push('maxBet and maxBetRate are two ways to set the same limit; give one');
  }
  if (
    maxBetFloor !== null &&
    maxBetFloor !== undefined &&
    maxBetCeiling !== null &&
    maxBetCeiling !== undefined &&
    moneyCompare(maxBetFloor, maxBetCeiling) > 0
  ) {
    issues.push('maxBetFloor must not exceed maxBetCeiling');
  }
  return issues;
}

import type { WagerContext } from '@openora/core/contracts';
import { moneyDivide, moneyScaleBy } from '@openora/core/server';
import type { WagerWeightScope } from '../contract/index.js';

/** One row of a weight profile: how much a bet matching `scope`/`scopeRef` contributes. */
export type WagerWeightRow = {
  scope: WagerWeightScope;
  /** The game id, category slug or product this row targets. Null on the profile default. */
  scopeRef: string | null;
  contributionPercent: string;
};

const resolutionOrder: ReadonlyArray<{
  scope: WagerWeightScope;
  ref: (context: WagerContext) => string | undefined;
}> = [
  { scope: 'game', ref: (c) => c.gameId },
  { scope: 'category', ref: (c) => c.categorySlug },
  { scope: 'product', ref: (c) => c.product },
  { scope: 'default', ref: () => undefined },
];

/**
 * The percentage of a bet's stake that counts toward wagering, given a profile's rows.
 *
 * Returns `'0'` when nothing matches, including when the profile has no default row: a bet the
 * operator never weighted must not advance a requirement, because the failure mode in the other
 * direction releases a player's bonus early and cannot be taken back.
 */
export function resolveContributionPercent(
  rows: readonly WagerWeightRow[],
  context: WagerContext,
): string {
  for (const level of resolutionOrder) {
    const ref = level.scope === 'default' ? null : level.ref(context);
    if (level.scope !== 'default' && ref === undefined) {
      continue;
    }
    const match = rows.find((r) => r.scope === level.scope && r.scopeRef === ref);
    if (match) {
      return match.contributionPercent;
    }
  }
  return '0';
}

/**
 * The part of `stake` that counts toward wagering at `contributionPercent`. Exact decimal
 * arithmetic, truncating: a weighted stake is never rounded up, so weighting cannot complete a
 * requirement a fraction early.
 */
export function weightedStake(stake: string, contributionPercent: string): string {
  return moneyDivide(moneyScaleBy(stake, contributionPercent), '100');
}

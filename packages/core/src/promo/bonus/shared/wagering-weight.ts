import {
  isUsableRtp,
  isWagerProduct,
  type WagerContext,
  type WagerContributionMode,
} from '@openora/core/contracts';
import { moneyCompare, moneyDivide, moneyScaleBy, moneySubtract } from '@openora/core/server';
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
 * direction releases a player's bonus early and cannot be taken back. An unknown product counts
 * nothing for the same reason, even under a positive default.
 */
export function resolveContributionPercent(
  rows: readonly WagerWeightRow[],
  context: WagerContext,
): string {
  if (!isWagerProduct(context.product)) {
    return '0';
  }
  for (const level of resolutionOrder) {
    const ref = level.scope === 'default' ? null : level.ref(context);
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

type Contribution = {
  /** The profile row's percent for this bet. */
  categoryPercent: string;
  /** What a stake is scored at: the row's percent, scaled by the house edge in that mode. */
  effectivePercent: string;
  /** The reference edge the score was scaled against; null when the mode did not use one. */
  referenceEdge: string | null;
};

/**
 * How much of a bet counts, by the grant's mode. In `house_edge` mode the profile percent is
 * scaled by `min(1, (1 - rtp) / referenceEdge)`; a bet with no usable rtp counts nothing, since
 * guessing its edge could release a bonus on a game that never earned it. Truncating throughout.
 */
export function effectiveContribution(args: {
  rows: readonly WagerWeightRow[];
  context: WagerContext;
  mode: WagerContributionMode;
  referenceEdge?: string | null | undefined;
}): Contribution {
  const categoryPercent = resolveContributionPercent(args.rows, args.context);
  if (args.mode === 'flat') {
    return { categoryPercent, effectivePercent: categoryPercent, referenceEdge: null };
  }
  const { rtp } = args.context;
  const edge = args.referenceEdge ?? null;
  if (!isUsableRtp(rtp) || !isUsableRtp(edge)) {
    return { categoryPercent, effectivePercent: '0', referenceEdge: edge };
  }
  const scaled = moneyDivide(moneySubtract('1', rtp), edge);
  const base = moneyCompare(scaled, '1') > 0 ? '1' : scaled;
  return {
    categoryPercent,
    effectivePercent: moneyScaleBy(categoryPercent, base),
    referenceEdge: edge,
  };
}

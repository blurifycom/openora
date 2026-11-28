import {
  isUsableRtp,
  isWagerProduct,
  type WagerContext,
  type WagerContributionMode,
} from '@openora/core/contracts';
import { moneyCompare, moneyDivide, moneyScaleBy, moneySubtract } from '@openora/core/server';
import type { WagerWeightScope } from '../contract/index.js';

export type WagerWeightRow = {
  scope: WagerWeightScope;
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

export function weightedStake(stake: string, contributionPercent: string): string {
  return moneyDivide(moneyScaleBy(stake, contributionPercent), '100');
}

type Contribution = {
  categoryPercent: string;
  effectivePercent: string;
  referenceEdge: string | null;
};

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

import {
  moneyAdd,
  moneyCompare,
  moneyFloorToScale,
  moneyMultiplyDivide,
  moneySubtract,
} from '@openora/core/server';
import type {
  BonusFreeFundsOrder,
  BonusFundSettings,
  BonusRolloverBase,
} from '@openora/core/contracts';
import { grantAmountFor } from './grant-amount.js';

const ZERO = '0';

/** Free real money, bucket A (unlinked), bucket B (linked) and bucket C (bonus). */
export type FundSplit = { free: string; unlinked: string; linked: string; bonus: string };
export type FundBucket = keyof FundSplit;

export const DEFAULT_FUND_SETTINGS: BonusFundSettings = {
  rolloverBase: 'bonus',
  existingBalance: 'free',
  freeFundsOrder: 'first',
  dustThresholdUsd: '0.01',
  decimals: 18,
};

export const EMPTY_SPLIT: FundSplit = { free: ZERO, unlinked: ZERO, linked: ZERO, bonus: ZERO };

/** The most restricted bucket first: where a return's rounding residue lands. */
const RESIDUE_ORDER: readonly FundBucket[] = ['bonus', 'linked', 'unlinked', 'free'];

const min = (a: string, b: string) => (moneyCompare(a, b) <= 0 ? a : b);

/**
 * A deposit's buckets: C is the capped match, B the part of the deposit that C matched, A the
 * rest. Rounded down to the currency precision, so the player is never credited a fraction the
 * currency cannot hold.
 */
export function depositBuckets(args: {
  deposit: string;
  matchPercent: string;
  maxGrantAmount: string;
  decimals: number;
}): { bonus: string; linked: string; unlinked: string } {
  const bonus = moneyFloorToScale(
    grantAmountFor(args.deposit, args.matchPercent, args.maxGrantAmount),
    args.decimals,
  );
  const matched = moneyMultiplyDivide(bonus, '100', args.matchPercent);
  const linked = moneyFloorToScale(min(args.deposit, matched), args.decimals);
  return { bonus, linked, unlinked: moneySubtract(args.deposit, linked) };
}

export function wageringBase(
  base: BonusRolloverBase,
  buckets: { bonus: string; linked: string },
): string {
  return base === 'bonus' ? buckets.bonus : moneyAdd(buckets.bonus, buckets.linked);
}

/**
 * A and B never claim more than the real balance holds: a withdrawal or a non-bonus debit may
 * have taken real money the counters still name. The shortfall comes off A before B, since B is
 * the cash the bonus was matched against.
 */
export function clampCounters(args: { real: string; unlinked: string; linked: string }): {
  unlinked: string;
  linked: string;
} {
  const real = moneyCompare(args.real, ZERO) > 0 ? args.real : ZERO;
  const linked = min(args.linked, real);
  const unlinked = min(args.unlinked, moneySubtract(real, linked));
  return { unlinked, linked };
}

export function spendOrder(order: BonusFreeFundsOrder): readonly FundBucket[] {
  return order === 'first'
    ? ['free', 'unlinked', 'linked', 'bonus']
    : ['unlinked', 'linked', 'bonus', 'free'];
}

/** The stake taken bucket by bucket in spend order, or null when all of them together fall short. */
export function splitStake(args: {
  stake: string;
  available: FundSplit;
  order: BonusFreeFundsOrder;
  bonusAllowed: boolean;
}): FundSplit | null {
  const split: FundSplit = { ...EMPTY_SPLIT };
  let remaining = args.stake;
  for (const bucket of spendOrder(args.order)) {
    if (moneyCompare(remaining, ZERO) <= 0) {
      break;
    }
    if (bucket === 'bonus' && !args.bonusAllowed) {
      continue;
    }
    const taken = min(remaining, args.available[bucket]);
    if (moneyCompare(taken, ZERO) > 0) {
      split[bucket] = taken;
      remaining = moneySubtract(remaining, taken);
    }
  }
  return moneyCompare(remaining, ZERO) > 0 ? null : split;
}

/**
 * A win, refund or rollback split back across the buckets in proportion to what each paid in.
 * Each share is truncated; the residue goes to the most restricted bucket that paid, so rounding
 * never moves bonus money into a freer bucket.
 */
export function splitReturn(amount: string, paid: FundSplit): FundSplit {
  const shares = splitAcross(
    amount,
    RESIDUE_ORDER.map((bucket) => paid[bucket]),
  );
  if (shares === null) {
    return { ...EMPTY_SPLIT, free: amount };
  }
  const [bonus, linked, unlinked, free] = shares as [string, string, string, string];
  return { free, unlinked, linked, bonus };
}

/**
 * `amount` across `pots` in proportion, each share truncated, the residue on the first pot that
 * holds anything - so callers list pots most restricted first. Null when every pot is empty.
 */
export function splitAcross(amount: string, pots: readonly string[]): string[] | null {
  const total = pots.reduce((sum, pot) => moneyAdd(sum, pot), ZERO);
  if (moneyCompare(total, ZERO) <= 0) {
    return null;
  }
  const shares = pots.map((pot) =>
    moneyCompare(pot, ZERO) > 0 ? moneyMultiplyDivide(amount, pot, total) : ZERO,
  );
  const residue = moneySubtract(
    amount,
    shares.reduce((sum, share) => moneyAdd(sum, share), ZERO),
  );
  const target = pots.findIndex((pot) => moneyCompare(pot, ZERO) > 0);
  return shares.map((share, i) => (i === target ? moneyAdd(share, residue) : share));
}

export function sumSplit(split: FundSplit): string {
  return moneyAdd(moneyAdd(split.free, split.unlinked), moneyAdd(split.linked, split.bonus));
}

/** Below the dust threshold, or exactly empty when there is none. */
export function isDepleted(total: string, dust: string): boolean {
  return moneyCompare(total, ZERO) <= 0 || moneyCompare(total, dust) < 0;
}

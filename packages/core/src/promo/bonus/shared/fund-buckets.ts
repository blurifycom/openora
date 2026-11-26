import {
  moneyAdd,
  moneyCompare,
  moneyFloorToScale,
  moneyMultiplyDivide,
  moneySubtract,
} from '@openora/core/server';
import type {
  BonusBetClass,
  BonusFundSettings,
  BonusGrantSource,
  BonusRolloverBase,
  WagerContext,
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

const EMPTY_SPLIT: FundSplit = { free: ZERO, unlinked: ZERO, linked: ZERO, bonus: ZERO };

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

export function grantLocks(
  source: BonusGrantSource,
  terms: { funds?: Pick<BonusFundSettings, 'lockWithdrawals'> | undefined },
): boolean {
  return terms.funds?.lockWithdrawals ?? source === 'deposit';
}

/** Real money the locking grants' A and B tie up, clamped to the real balance, and the rest. */
export function splitLocked(
  real: string,
  grants: readonly { unlinked: string; linked: string }[],
): { locked: string; free: string } {
  const counters = clampCounters({
    real,
    unlinked: grants.reduce((sum, grant) => moneyAdd(sum, grant.unlinked), ZERO),
    linked: grants.reduce((sum, grant) => moneyAdd(sum, grant.linked), ZERO),
  });
  const locked = moneyAdd(counters.unlinked, counters.linked);
  const free = moneySubtract(real, locked);
  return { locked, free: moneyCompare(free, ZERO) > 0 ? free : ZERO };
}

/** The one figure every lock check and every read reports: only the grants that lock count. */
export function lockedFundsOf(
  real: string,
  grants: readonly {
    source: BonusGrantSource;
    terms: { funds?: Pick<BonusFundSettings, 'lockWithdrawals'> | undefined };
    unlinked: string;
    linked: string;
  }[],
): { locked: string; free: string } {
  return splitLocked(
    real,
    grants.filter((grant) => grantLocks(grant.source, grant.terms)),
  );
}

/** A PvP bet is its own class whatever its weight; otherwise it contributes or it does not. */
export function betClass(context: WagerContext, effectivePercent: string): BonusBetClass {
  if (context.product === 'pvp') {
    return 'pvp';
  }
  return moneyCompare(effectivePercent, ZERO) > 0 ? 'contributing' : 'zero';
}

const GRANT_BUCKETS = ['unlinked', 'linked', 'bonus'] as const satisfies readonly FundBucket[];

/**
 * The buckets a bet of `cls` may draw on: free real money always, the grant buckets its class is
 * configured for (all three when it is not), and never C on a product the grant excludes.
 */
export function allowedBuckets(
  settings: BonusFundSettings,
  cls: BonusBetClass,
  bonusExcluded: boolean,
): ReadonlySet<FundBucket> {
  const allowed = new Set<FundBucket>([
    'free',
    ...(settings.betClassBuckets?.[cls] ?? GRANT_BUCKETS),
  ]);
  if (bonusExcluded) {
    allowed.delete('bonus');
  }
  return allowed;
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

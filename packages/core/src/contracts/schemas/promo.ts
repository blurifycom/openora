import * as z from 'zod';
import { isUsableRtp } from '../adapters/wager-context.js';

// Canonical promo value sets. Declared here rather than in the promo module because the
// isomorphic event and adapter contracts reference them and cannot import from a domain.

/** What caused a grant. Half of its idempotency key. */
export const BONUS_GRANT_SOURCES = [
  'deposit',
  'manual',
  'streak',
  'rank',
  'race',
  'gift',
  'rain',
  // A VIP Cashback grant, computed and credited by a scheduled job off a player's net loss
  // over a period rather than off a deposit - system-actor like 'streak'/'rank'/'race', not
  // 'manual' (no admin issued it) and not 'deposit' (no deposit earned it).
  'cashback',
  'donation',
] as const;

/**
 * `pending` is a grant that is claimed but not yet funded, `cancelled` its only exit - nothing
 * was credited, so there is nothing to lose. Everything after funding ends in `completed`,
 * `expired`, `forfeited` or `depleted` (every bucket spent below the dust threshold, no bet open).
 */
export const BONUS_GRANT_STATUSES = [
  'pending',
  'active',
  'completed',
  'expired',
  'forfeited',
  'cancelled',
  'depleted',
] as const;

/** Why an active grant was taken away. Recorded on every forfeit, for the regulator. */
export const BONUS_FORFEIT_REASONS = [
  'self_exclusion',
  'cooling_off',
  'account_closed',
  // The account was deactivated (banned) - an admin acted on the account, not on the bonus.
  'account_deactivated',
  'admin',
  'player_opt_out',
  'withdrawal_while_active',
  // An offer's own terms breached by the player - e.g. an Activity Bonus that missed a
  // required wagering day - closed by a scheduled job rather than an admin or an RG event.
  'terms_breach',
] as const;

/** What a grant's wagering requirement multiplies: the bonus, or the bonus plus the linked deposit. */
export const BONUS_ROLLOVER_BASES = ['bonus', 'bonus_plus_linked'] as const;
/** Whether real money held before the bonus stays free or is locked into the unlinked bucket. */
export const BONUS_EXISTING_BALANCE_MODES = ['free', 'locked'] as const;
/** Whether free real money is spent before the bonus buckets or after them. */
export const BONUS_FREE_FUNDS_ORDERS = ['first', 'last'] as const;

export const PROMO_OFFER_STATUSES = ['draft', 'active', 'paused', 'archived'] as const;

export const BONUS_GRANT_ENTRY_TYPES = [
  'grant',
  'stake',
  'win',
  'reversal',
  'convert',
  'forfeit',
  'expire',
  // A settled round's weighted stake credited to the requirement; moves no funds.
  'progress',
] as const;

/**
 * How a bet's weight is scored: `flat` takes the profile's percent as is, `house_edge` scales it
 * by the game's edge against the profile's reference edge, capped at the full percent.
 */
export const WAGER_CONTRIBUTION_MODES = ['flat', 'house_edge'] as const;
/** What a bet is for the funding rules: it contributes, it contributes nothing, or it is PvP. */
export const BONUS_BET_CLASSES = ['contributing', 'zero', 'pvp'] as const;
/** The grant buckets a bet class may draw on. Free real money is never restricted. */
export const BONUS_GRANT_BUCKETS = ['unlinked', 'linked', 'bonus'] as const;

export const BonusGrantSourceSchema = z.enum(BONUS_GRANT_SOURCES);
export const BonusGrantStatusSchema = z.enum(BONUS_GRANT_STATUSES);
export const BonusForfeitReasonSchema = z.enum(BONUS_FORFEIT_REASONS);
export const BonusGrantEntryTypeSchema = z.enum(BONUS_GRANT_ENTRY_TYPES);
export const PromoOfferStatusSchema = z.enum(PROMO_OFFER_STATUSES);
export const BonusRolloverBaseSchema = z.enum(BONUS_ROLLOVER_BASES);
export const BonusExistingBalanceModeSchema = z.enum(BONUS_EXISTING_BALANCE_MODES);
export const BonusFreeFundsOrderSchema = z.enum(BONUS_FREE_FUNDS_ORDERS);
export const WagerContributionModeSchema = z.enum(WAGER_CONTRIBUTION_MODES);
export const BonusBetClassSchema = z.enum(BONUS_BET_CLASSES);
export const BonusGrantBucketSchema = z.enum(BONUS_GRANT_BUCKETS);

export type BonusGrantSource = z.infer<typeof BonusGrantSourceSchema>;
export type BonusGrantStatus = z.infer<typeof BonusGrantStatusSchema>;
export type BonusForfeitReason = z.infer<typeof BonusForfeitReasonSchema>;
export type BonusGrantEntryType = z.infer<typeof BonusGrantEntryTypeSchema>;
export type PromoOfferStatus = z.infer<typeof PromoOfferStatusSchema>;
export type BonusRolloverBase = z.infer<typeof BonusRolloverBaseSchema>;
export type BonusExistingBalanceMode = z.infer<typeof BonusExistingBalanceModeSchema>;
export type BonusFreeFundsOrder = z.infer<typeof BonusFreeFundsOrderSchema>;
export type WagerContributionMode = z.infer<typeof WagerContributionModeSchema>;
export type BonusBetClass = z.infer<typeof BonusBetClassSchema>;
export type BonusGrantBucket = z.infer<typeof BonusGrantBucketSchema>;

// The reference house edge a `house_edge` profile scores against, as a decimal fraction in
// (0, 1] in the same shape as a wager's rtp; `numeric(19,18)` in the database.
export const REFERENCE_EDGE_PRECISION = 19;
export const REFERENCE_EDGE_SCALE = 18;
export const ReferenceEdgeSchema = z
  .string()
  .refine(isUsableRtp, 'must be a decimal fraction in (0, 1] with at most 18 places');

/** How the rank daily, weekly and monthly bonuses are sized; see `promo.rankPeriodic.basis`. */
export const RANK_PERIODIC_BASES = ['flat', 'margin'] as const;
export const RANK_PERIODIC_REWARD_KINDS = ['daily', 'weekly', 'monthly'] as const;
/** `auto_paid`: paid without a claim, on self-exclusion or account closure. */
export const RANK_PERIODIC_REWARD_STATUSES = ['claimable', 'claimed', 'auto_paid'] as const;
export type RankPeriodicBasis = (typeof RANK_PERIODIC_BASES)[number];

/** Which stake advances rank progress; see `promo.ranks.progressBasis`. */
export const RANK_PROGRESS_BASES = ['total', 'real'] as const;
export type RankProgressBasis = (typeof RANK_PROGRESS_BASES)[number];

/** How many bonus grants a player may have active at once; see `promo.bonus.grantConcurrency`. */
export const GRANT_CONCURRENCY_MODES = ['single', 'per_source', 'multiple'] as const;
export type GrantConcurrencyMode = (typeof GRANT_CONCURRENCY_MODES)[number];

/** What a grant does when its concurrency slot is taken: wait as pending, or not be made at all. */
export const GRANT_SLOT_TAKEN_POLICIES = ['pending', 'refuse'] as const;
export const GrantSlotTakenPolicySchema = z.enum(GRANT_SLOT_TAKEN_POLICIES);
export type GrantSlotTakenPolicy = z.infer<typeof GrantSlotTakenPolicySchema>;

// A weight as a percentage of the stake, `numeric(5,2)` in the database. Zero excludes a product
// or game from wagering; above 100 would count a bet for more than it was worth.
export const CONTRIBUTION_PERCENT_PRECISION = 5;
export const CONTRIBUTION_PERCENT_SCALE = 2;
const CONTRIBUTION_PERCENT_FORMAT = /^\d{1,3}(\.\d{1,2})?$/;
export const ContributionPercentSchema = z
  .string()
  .regex(CONTRIBUTION_PERCENT_FORMAT, 'must be a decimal string with at most two decimal places')
  .refine((v) => {
    // Zod still runs this after the format check failed; let that error be the one reported.
    if (!CONTRIBUTION_PERCENT_FORMAT.test(v)) {
      return true;
    }
    const [whole = '0', fraction = ''] = v.split('.');
    return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')) <= 10_000n;
  }, 'must not exceed 100');

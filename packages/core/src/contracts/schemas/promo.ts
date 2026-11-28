import * as z from 'zod';
import { isUsableRtp } from '../adapters/wager-context.js';

export const BONUS_GRANT_SOURCES = [
  'deposit',
  'manual',
  'streak',
  'rank',
  'race',
  'gift',
  'rain',
  'cashback',
  'donation',
] as const;

export const BONUS_GRANT_STATUSES = [
  'pending',
  'active',
  'completed',
  'expired',
  'forfeited',
  'cancelled',
  'depleted',
] as const;

export const BONUS_FORFEIT_REASONS = [
  'self_exclusion',
  'cooling_off',
  'account_closed',
  'account_deactivated',
  'admin',
  'player_opt_out',
  'withdrawal_while_active',
  'terms_breach',
] as const;

export const BONUS_ROLLOVER_BASES = ['bonus', 'bonus_plus_linked'] as const;
export const BONUS_EXISTING_BALANCE_MODES = ['free', 'locked'] as const;
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
  'progress',
] as const;

export const WAGER_CONTRIBUTION_MODES = ['flat', 'house_edge'] as const;
export const BONUS_BET_CLASSES = ['contributing', 'zero', 'pvp'] as const;
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

export const REFERENCE_EDGE_PRECISION = 19;
export const REFERENCE_EDGE_SCALE = 18;
export const ReferenceEdgeSchema = z
  .string()
  .refine(isUsableRtp, 'must be a decimal fraction in (0, 1] with at most 18 places');

export const RANK_PERIODIC_BASES = ['flat', 'margin'] as const;
export const RANK_PERIODIC_REWARD_KINDS = ['daily', 'weekly', 'monthly'] as const;
export const RANK_PERIODIC_REWARD_STATUSES = ['claimable', 'claimed', 'auto_paid'] as const;
export type RankPeriodicBasis = (typeof RANK_PERIODIC_BASES)[number];

export const RANK_PROGRESS_BASES = ['total', 'real'] as const;
export type RankProgressBasis = (typeof RANK_PROGRESS_BASES)[number];

export const GRANT_CONCURRENCY_MODES = ['single', 'per_source', 'multiple'] as const;
export type GrantConcurrencyMode = (typeof GRANT_CONCURRENCY_MODES)[number];

export const GRANT_SLOT_TAKEN_POLICIES = ['pending', 'refuse'] as const;
export const GrantSlotTakenPolicySchema = z.enum(GRANT_SLOT_TAKEN_POLICIES);
export type GrantSlotTakenPolicy = z.infer<typeof GrantSlotTakenPolicySchema>;

export const CONTRIBUTION_PERCENT_PRECISION = 5;
export const CONTRIBUTION_PERCENT_SCALE = 2;
const CONTRIBUTION_PERCENT_FORMAT = /^\d{1,3}(\.\d{1,2})?$/;
export const ContributionPercentSchema = z
  .string()
  .regex(CONTRIBUTION_PERCENT_FORMAT, 'must be a decimal string with at most two decimal places')
  .refine((v) => {
    if (!CONTRIBUTION_PERCENT_FORMAT.test(v)) {
      return true;
    }
    const [whole = '0', fraction = ''] = v.split('.');
    return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')) <= 10_000n;
  }, 'must not exceed 100');

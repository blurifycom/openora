import * as z from 'zod';

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
] as const;

/**
 * `pending` is a grant that is claimed but not yet funded, `cancelled` its only exit - nothing
 * was credited, so there is nothing to lose. Everything after funding ends in `completed`,
 * `expired` or `forfeited`.
 */
export const BONUS_GRANT_STATUSES = [
  'pending',
  'active',
  'completed',
  'expired',
  'forfeited',
  'cancelled',
] as const;

/** Why an active grant was taken away. Recorded on every forfeit, for the regulator. */
export const BONUS_FORFEIT_REASONS = [
  'self_exclusion',
  'cooling_off',
  'account_closed',
  'admin',
  'player_opt_out',
  'withdrawal_while_active',
  // An offer's own terms breached by the player - e.g. an Activity Bonus that missed a
  // required wagering day - closed by a scheduled job rather than an admin or an RG event.
  'terms_breach',
] as const;

export const PROMO_OFFER_STATUSES = ['draft', 'active', 'paused', 'archived'] as const;

export const BONUS_GRANT_ENTRY_TYPES = [
  'grant',
  'stake',
  'win',
  'reversal',
  'convert',
  'forfeit',
  'expire',
] as const;

export const BonusGrantSourceSchema = z.enum(BONUS_GRANT_SOURCES);
export const BonusGrantStatusSchema = z.enum(BONUS_GRANT_STATUSES);
export const BonusForfeitReasonSchema = z.enum(BONUS_FORFEIT_REASONS);
export const BonusGrantEntryTypeSchema = z.enum(BONUS_GRANT_ENTRY_TYPES);
export const PromoOfferStatusSchema = z.enum(PROMO_OFFER_STATUSES);

export type BonusGrantSource = z.infer<typeof BonusGrantSourceSchema>;
export type BonusGrantStatus = z.infer<typeof BonusGrantStatusSchema>;
export type BonusForfeitReason = z.infer<typeof BonusForfeitReasonSchema>;
export type BonusGrantEntryType = z.infer<typeof BonusGrantEntryTypeSchema>;
export type PromoOfferStatus = z.infer<typeof PromoOfferStatusSchema>;

// A weight as a percentage of the stake, `numeric(5,2)` in the database. Zero excludes a product
// or game from wagering; above 100 would count a bet for more than it was worth.
export const CONTRIBUTION_PERCENT_PRECISION = 5;
export const CONTRIBUTION_PERCENT_SCALE = 2;
export const ContributionPercentSchema = z
  .string()
  .regex(/^\d{1,3}(\.\d{1,2})?$/, 'must be a decimal string with at most two decimal places')
  .refine((v) => {
    const [whole = '0', fraction = ''] = v.split('.');
    return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')) <= 10_000n;
  }, 'must not exceed 100');

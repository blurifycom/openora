import * as z from 'zod';
import { ContributionPercentSchema, TimestampSchema, UuidSchema } from '@openora/core/contracts';

/**
 * What a weight row targets, most specific first. A bet resolves against a profile in this
 * order and takes the first row that matches; `default` is the profile's catch-all.
 */
export const WAGER_WEIGHT_SCOPES = ['game', 'category', 'product', 'default'] as const;
export const WagerWeightScopeSchema = z.enum(WAGER_WEIGHT_SCOPES);
export type WagerWeightScope = z.infer<typeof WagerWeightScopeSchema>;

export const WagerWeightSchema = z.object({
  id: UuidSchema,
  profileId: UuidSchema,
  scope: WagerWeightScopeSchema,
  /** The game id, category slug or product this row targets; null on the profile default. */
  scopeRef: z.string().min(1).nullable(),
  contributionPercent: ContributionPercentSchema,
  createdAt: TimestampSchema,
});

export type WagerWeight = z.infer<typeof WagerWeightSchema>;

export const WagerWeightProfileSchema = z.object({
  id: UuidSchema,
  name: z.string().min(1).max(120),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export type WagerWeightProfile = z.infer<typeof WagerWeightProfileSchema>;

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
export type BonusGrantStatus = (typeof BONUS_GRANT_STATUSES)[number];

/** Why an active grant was taken away. Recorded on every forfeit, for the regulator. */
export const BONUS_FORFEIT_REASONS = [
  'self_exclusion',
  'account_closed',
  'admin',
  'player_opt_out',
  'withdrawal_while_active',
] as const;
export type BonusForfeitReason = (typeof BONUS_FORFEIT_REASONS)[number];

/** What caused a grant. Half of its idempotency key. */
export const BONUS_GRANT_SOURCES = [
  'deposit',
  'manual',
  'streak',
  'rank',
  'race',
  'gift',
  'rain',
] as const;
export const BonusGrantSourceSchema = z.enum(BONUS_GRANT_SOURCES);

/**
 * One movement on a grant's own ledger. Append-only: a correction is another row, never an edit,
 * because the spec demands every credit, debit, conversion and forfeiture be recorded immutably.
 *
 * `stake` and `win` carry the provider round, which is how a win finds the grant that funded the
 * bet. `reversal` undoes a voided round: the bonus stake goes back and its wagering progress with
 * it, because money returned without progress returned is free wagering bought by a rollback.
 */
export const BONUS_GRANT_ENTRY_TYPES = [
  'grant',
  'stake',
  'win',
  'reversal',
  'convert',
  'forfeit',
  'expire',
] as const;
export type BonusGrantEntryType = (typeof BONUS_GRANT_ENTRY_TYPES)[number];
export const BonusGrantEntryTypeSchema = z.enum(BONUS_GRANT_ENTRY_TYPES);

export const bonusContract = {};

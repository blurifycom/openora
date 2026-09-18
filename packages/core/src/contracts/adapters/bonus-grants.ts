/**
 * Bonus grant command port: a module that has decided a player earned a bonus calls this on its
 * own transaction handle, so the grant, the money movement and the audit row commit or roll back
 * together. Mirrors the WALLET_COMMANDS idiom (ADR-0017) - `tx: unknown` so neither side imports
 * the other's DB module.
 */
import type { BonusGrantSource } from '../schemas/promo.js';
import { createToken, type Token } from './token.js';

/**
 * The terms a grant is created under. The grant row stores a snapshot of them, with the weight
 * profile's rows resolved into it, so editing or deleting an offer or a profile never changes a
 * bonus a player already holds.
 */
export type BonusGrantTerms = {
  /** Wagering requirement as a multiple of the granted amount, as a decimal string. */
  wageringMultiplier: string;
  /** Days from the grant until it expires and what is left of it is forfeited. */
  expiryDays: number;
  /**
   * Weight profile whose rows are copied onto the grant to score its bets. Omitted by a caller
   * that has no offer behind it - a chat gift, a rain drop - which falls back to the profile the
   * module seeds as the operator's default. A grant whose profile cannot be resolved is refused
   * rather than scored at nothing.
   */
  weightProfileId?: string;
};

/**
 * Who asked for the grant. A `manual` grant is an admin handing a player money, so it carries
 * that admin onto the audit row; every other source is a rule firing with no person behind it.
 */
export type BonusGrantActor = { type: 'admin'; id: string } | { type: 'system' };

export type BonusGrantArgs = {
  userId: string;
  currency: string;
  /** Bonus amount to credit, as a decimal string. */
  amount: string;
  source: BonusGrantSource;
  /**
   * Stable identifier of the thing that caused the grant - the deposit transaction id, the
   * `<mechanic>:<utc-day>` key of a daily job, the race id. Unique per `(userId, source)`, so a
   * replayed deposit or a re-run job resolves to the first grant instead of creating a second.
   */
  sourceRef: string;
  actor: BonusGrantActor;
  /** Offer the grant is created from, when one exists. Absent for a manual or a job grant. */
  offerId?: string;
  /**
   * Omitted by a caller with no offer behind it - a chat gift, a rain drop. The bonus module
   * owns what those are granted under; the wallet only reports that money was given.
   */
  terms?: BonusGrantTerms;
};

export type BonusGrantOutcome =
  | {
      ok: true;
      grantId: string;
      /** False when the idempotency guard matched an existing grant and nothing was credited. */
      created: boolean;
    }
  | { ok: false; reason: 'ineligible' | 'offer_inactive' | 'currency_unsupported' };

export type BonusGrantCommands = {
  grant(tx: unknown, args: BonusGrantArgs): Promise<BonusGrantOutcome>;
};

export const BONUS_GRANTS: Token<BonusGrantCommands> = createToken('BONUS_GRANTS');

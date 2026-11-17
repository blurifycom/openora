/**
 * Bonus grant command port: a module that has decided a player earned a bonus calls this on its
 * own transaction handle, so the grant, the money movement and the audit row commit or roll back
 * together. Mirrors the WALLET_COMMANDS idiom (ADR-0017) - `tx: unknown` so neither side imports
 * the other's DB module.
 */
import type { BonusGrantSource, BonusGrantStatus, GrantSlotTakenPolicy } from '../schemas/promo.js';
import { createToken, type Token } from './token.js';
import type { WagerProduct } from './wager-context.js';

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
   * that has no offer behind it - a chat gift, a rain drop, a donation - which falls back to the
   * profile the module seeds as the operator's default. A grant whose profile cannot be resolved
   * is refused rather than scored at nothing.
   */
  weightProfileId?: string;
  /**
   * Largest total stake of one round allowed while this grant is active, as a decimal string, or
   * absent for no limit. An anti-abuse control, so it is enforced inside the debit transaction
   * against this snapshot rather than checked by a caller beforehand. On a grant created with
   * `maxBetRate` this is the value resolved at grant time; a caller sets one or the other.
   */
  maxBet?: string | null;
  /**
   * Max bet as a fraction of the granted amount (`'0.1'` is 10%). Absent means no limit, whatever
   * the floor and ceiling say. Resolved once when the grant is created.
   */
  maxBetRate?: string | null;
  /** Lower bound on the rate-derived max bet, in the grant's currency. */
  maxBetFloor?: string | null;
  /** Upper bound on the rate-derived max bet, in the grant's currency. */
  maxBetCeiling?: string | null;
  /** Products whose stakes the max bet never applies to. Absent or empty exempts none. */
  maxBetExemptProducts?: WagerProduct[];
  /**
   * Cap on what the grant can ever convert into real money, as a multiple of the granted amount.
   * Absent means uncapped. Without one a modest bonus can compound into a payout the operator
   * never priced.
   */
  maxWinMultiplier?: string | null;
  /**
   * Products bonus funds cannot pay for while this grant is active. Absent or empty allows every
   * product. A stake on an excluded product is paid from real funds only.
   */
  excludedProducts?: WagerProduct[];
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
   * Omitted by a caller with no offer behind it - a chat gift, a rain drop, a donation. The bonus
   * module owns what those are granted under; the wallet only reports that money was given.
   */
  terms?: BonusGrantTerms;
  /**
   * What happens when `promo.bonus.grantConcurrency` leaves no free slot: `pending` (the default)
   * creates the grant pending for the player to activate later; `refuse` creates nothing and
   * answers `slot_taken`.
   */
  onSlotTaken?: GrantSlotTakenPolicy;
};

export type BonusGrantOutcome =
  | {
      ok: true;
      grantId: string;
      /** False when the idempotency guard matched an existing grant and nothing was credited. */
      created: boolean;
      /** `pending` when the grant waits for a free slot before it can be played. */
      status?: BonusGrantStatus;
    }
  | {
      ok: false;
      reason: 'ineligible' | 'offer_inactive' | 'currency_unsupported' | 'slot_taken';
    };

export type BonusGrantCommands = {
  grant(tx: unknown, args: BonusGrantArgs): Promise<BonusGrantOutcome>;
};

export const BONUS_GRANTS: Token<BonusGrantCommands> = createToken('BONUS_GRANTS');

/**
 * Bonus grant command port: a module that has decided a player earned a bonus calls this on its
 * own transaction handle, so the grant, the money movement and the audit row commit or roll back
 * together. Mirrors the WALLET_COMMANDS idiom (ADR-0017) - `tx: unknown` so neither side imports
 * the other's DB module.
 *
 * Callers: the deposit path, the streak, rank and race payout jobs, and the admin manual grant.
 * The implementation is sealed (BONUS_WAGERING_ENGINE): an operator configures the terms of a
 * bonus, never the arithmetic that applies them.
 */
import { createToken, type Token } from './token.js';

/** What caused the grant. Half of the idempotency key. */
export type BonusGrantSource = 'deposit' | 'manual' | 'streak' | 'rank' | 'race' | 'gift' | 'rain';

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
  /** Offer the grant is created from, when one exists. Absent for a manual or a job grant. */
  offerId?: string;
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

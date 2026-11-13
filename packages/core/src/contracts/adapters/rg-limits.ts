import type { LimitType, LimitPeriod, RgLimitErrorReason } from '../schemas/compliance.js';
import type { RgLimitsSnapshot } from '../schemas/ledger.js';
import { createSealedToken, type SealedToken } from './token.js';

export type RgLimitDecision =
  | { allowed: true }
  | {
      allowed: false;
      limitType: LimitType;
      period: LimitPeriod;
      /** The configured limit, decimal string. */
      limit: string;
      /** Spend already inside the period window, decimal string. */
      used: string;
      /** The currency `limit` and `used` are in; `null` or absent when it cannot be resolved. */
      currency?: string | null;
    };

export type RgLimitExceededData = {
  reason: RgLimitErrorReason;
  limitType: LimitType;
  period: LimitPeriod;
  limit: string;
  used: string;
  currency: string | null;
};

/** A money move refused by the player's own responsible-gambling limit. */
export class RgLimitExceededError extends Error {
  readonly data: RgLimitExceededData;

  constructor(reason: RgLimitErrorReason, decision: Extract<RgLimitDecision, { allowed: false }>) {
    super(
      `Refused: this would exceed the ${decision.period} ${decision.limitType} limit of ${decision.limit}${decision.currency ? ` ${decision.currency}` : ''} (${decision.used} already used)`,
    );
    this.name = 'RgLimitExceededError';
    this.data = {
      reason,
      limitType: decision.limitType,
      period: decision.period,
      limit: decision.limit,
      used: decision.used,
      currency: decision.currency ?? null,
    };
  }
}

/** Spend in a currency the limit's currency has no exchange rate from: the move is refused. */
export class RgRateUnavailableError extends Error {
  constructor(
    readonly limitType: LimitType,
    readonly period: LimitPeriod,
    readonly missingCurrency: string,
    readonly limitCurrency: string,
  ) {
    super(
      `No exchange rate available to convert ${missingCurrency} into ${limitCurrency} for the ${period} ${limitType} limit`,
    );
    this.name = 'RgRateUnavailableError';
  }
}

// Rolling windows (last N) rather than calendar buckets: a defensible, timezone-free reading of
// "daily/weekly/monthly" spend.
const PERIOD_MS: Record<Exclude<LimitPeriod, 'session'>, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};

/**
 * The advisory lock key of one limit slot. Every writer of a slot holds it, and the gate holds
 * it for every slot it reads, so a lower limit committing mid-check waits for the move.
 */
export const limitSlotKey = (userId: string, type: string, period: string) =>
  `rg-limit:${userId}:${type}:${period}`;

export function periodWindow(period: LimitPeriod, now: Date): { from: Date; to: Date } {
  if (period === 'session') {
    return { from: now, to: now };
  }
  return { from: new Date(now.getTime() - PERIOD_MS[period]), to: now };
}

/**
 * `amount` is the move being *attempted*: the gate answers "may this move happen", not
 * "has the limit already been passed".
 *
 * Check-then-act: a caller that must not exceed the limit has to invoke this inside the
 * transaction that performs the move, after taking whatever row lock serializes
 * concurrent moves for that player.
 *
 * `tx` is the caller's transaction and is mandatory; every read the gate makes runs on
 * it. A caller with no transaction of its own passes `drizzle.db`.
 *
 * Bound by wallet over its own `ledger_user_limit` projection (ADR-0055), so it is always
 * present where the wallet is. Fail-closed: a limit whose currency or exchange rate cannot be
 * resolved refuses the move, and a throwing `check*` refuses it too.
 */
export type RgLimitsPort = {
  checkDeposit(
    tx: unknown,
    userId: string,
    amount: string,
    currency: string,
  ): Promise<RgLimitDecision>;
  checkWager(
    tx: unknown,
    userId: string,
    amount: string,
    currency: string,
  ): Promise<RgLimitDecision>;
  /**
   * The player's reference currency: the currency of their deposit limit, else of their
   * wager limit (the most recently changed one when several are set). `null` when the player
   * has neither, so the caller applies its own default.
   */
  referenceCurrency(tx: unknown, userId: string): Promise<string | null>;
};

/** Sealed: rebinding the gate would turn off every deposit and wager limit. */
export const RG_LIMITS: SealedToken<RgLimitsPort> = createSealedToken<RgLimitsPort>('RG_LIMITS');

/**
 * The ledger's side of the limits projection. Wallet-internal: bound by wallet, called only by
 * compliance, the owner of every limit. See ADR-0055.
 */
export type RgLimitLedgerPort = {
  /**
   * The authoritative write, on the writer's `tx` after it took the user's version row lock, so
   * the projection commits or rolls back with the change it reflects. A stored version above
   * `snapshot`'s is overwritten and logged as an error: only a foreign writer can have put it there.
   */
  write(snapshot: RgLimitsSnapshot, tx: unknown): Promise<void>;
  /**
   * The outbox replay: keeps the newest version per user, writes only the users whose projection
   * is missing or strictly older, and returns how many it wrote. Never overwrites an equal version.
   */
  reconcile(snapshots: readonly RgLimitsSnapshot[]): Promise<number>;
  /**
   * Unlocked read for the backfill: the users whose projection does not match `snapshots` -
   * missing, at another version, or at the same version with other rows. Compliance repairs each
   * one through `write` under a fresh version, never by an equal-version overwrite.
   */
  drifted(snapshots: readonly RgLimitsSnapshot[]): Promise<string[]>;
  /**
   * Spend counted against one money limit since `from`, converted into `limitCurrency`, from the
   * wallet ledger. Throws `RgRateUnavailableError` when a source currency has no rate.
   */
  spendFor(
    db: unknown,
    userId: string,
    type: LimitType,
    period: LimitPeriod,
    from: Date,
    limitCurrency: string,
  ): Promise<string>;
};

export const RG_LIMIT_LEDGER: SealedToken<RgLimitLedgerPort> =
  createSealedToken<RgLimitLedgerPort>('RG_LIMIT_LEDGER');

import type { LimitType, LimitPeriod, RgLimitErrorReason } from '../schemas/compliance.js';
import { createToken, type Token } from './token.js';

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
    };

export type RgLimitExceededData = {
  reason: RgLimitErrorReason;
  limitType: LimitType;
  period: LimitPeriod;
  limit: string;
  used: string;
};

/** A money move refused by the player's own responsible-gambling limit. */
export class RgLimitExceededError extends Error {
  readonly data: RgLimitExceededData;

  constructor(reason: RgLimitErrorReason, decision: Extract<RgLimitDecision, { allowed: false }>) {
    super(
      `Refused: this would exceed the ${decision.period} ${decision.limitType} limit of ${decision.limit} (${decision.used} already used)`,
    );
    this.name = 'RgLimitExceededError';
    this.data = {
      reason,
      limitType: decision.limitType,
      period: decision.period,
      limit: decision.limit,
      used: decision.used,
    };
  }
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
 * Optional for its consumers (`c.has(RG_LIMITS)`); where bound, the gate is fail-closed -
 * a throwing `check*` refuses the move rather than letting it through.
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
};

export const RG_LIMITS: Token<RgLimitsPort> = createToken<RgLimitsPort>('RG_LIMITS');

import type { LimitType, LimitPeriod, RgLimitErrorReason } from '../schemas/compliance.js';
import { createToken, type Token } from './token.js';

/**
 * The decision a money-limit gate makes about one pending money move. `allowed: false`
 * carries the whole reason so a caller can hand the client a typed payload it can
 * translate - never a message string (see `conventions` -> Errors).
 */
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
  /**
   * Stable discriminator. Every route this can surface on shares its status code with
   * an unrelated error - `startRound` with an RG exclusion, `deposit` with an
   * idempotency-key reuse - so a client branches on this, never on the code and never
   * on the message.
   */
  reason: RgLimitErrorReason;
  limitType: LimitType;
  period: LimitPeriod;
  limit: string;
  used: string;
};

/**
 * A money move refused by the player's own responsible-gambling limit.
 *
 * Lives beside the port rather than in one module's service because it crosses the same
 * seam the port does: wallet raises it at the deposit and at the stake debit, and
 * casino/gaming has to map it on `startRound` without importing wallet internals. One
 * class, discriminated by `data.reason`, so there is a single thing for every router to
 * map and a single shape for every client to read.
 */
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
 * Read port for Responsible-Gambling money-limit enforcement - the amount dimension of
 * RG, alongside `PLAY_ELIGIBILITY`'s exclusion dimension (ADR-0032). Owned + bound by
 * the compliance module (it owns `user_limit` and the spend windows); wallet and gaming
 * depend only on this port, never on the compliance schema, so the dependency stays
 * one-way (compliance already `dependsOn: ['wallet', 'gaming']`).
 *
 * `amount` is the move being *attempted* and is included in the comparison: the gate
 * answers "may this move happen", not "has the limit already been passed".
 *
 * **Check-then-act.** These are reads. A caller that must not exceed the limit has to
 * invoke them inside the transaction that performs the move, after taking whatever row
 * lock serializes concurrent moves for that player - otherwise two concurrent callers
 * read the same usage and both pass. `WalletCommandsService.debit` does exactly that
 * (the `wallet` row's `FOR UPDATE`); the deposit path cannot, because a PSP round-trip
 * sits between the check and the credit - see `assertWithinRgDepositLimit`.
 *
 * Deliberately OPTIONAL for its consumers (`c.has(RG_LIMITS)`), not `requiresPorts`: an
 * install without the compliance module has no `user_limit` table and therefore nothing
 * to enforce. Where the port IS bound the gate is fail-closed - a throwing `check*`
 * refuses the move rather than letting it through.
 */
export type RgLimitsPort = {
  checkDeposit(userId: string, amount: string): Promise<RgLimitDecision>;
  checkWager(userId: string, amount: string): Promise<RgLimitDecision>;
};

export const RG_LIMITS: Token<RgLimitsPort> = createToken<RgLimitsPort>('RG_LIMITS');

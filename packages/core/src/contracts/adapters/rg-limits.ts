import type { LimitType, LimitPeriod } from '../schemas/compliance.js';
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

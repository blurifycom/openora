import { eq, and, ne } from 'drizzle-orm';
import { moneyAdd, moneyCompare, type DrizzleService } from '@openora/core/server';
import type {
  LimitPeriod,
  LimitType,
  RgLimitDecision,
  RgLimitsPort,
} from '@openora/core/contracts';
import { userLimit } from '../schema/index.js';
import type { RgMonitoringService } from '../service/rg-monitoring.service.js';
import { periodWindow } from '../service/rg-eval.js';

/**
 * Which limits each move is actually held to.
 *
 * `loss` is NOT enforced, and the omission is the point. Net loss is stakes minus
 * winnings, and this platform does not record winnings: `game_round.winAmount` stays
 * `'0'` on every row because win-crediting is deliberately deferred to a sealed
 * `GAME_OUTCOME_AUTHORITY` that does not exist yet (ADR-0034). Enforcing a loss limit
 * against that number would refuse a wager the moment a player's STAKES reached it -
 * turning "stop me when I'm down 100" into "stop me after I've bet 100", including for a
 * player who is up on the window. Refusing on a number the platform knows to be wrong is
 * worse than not refusing.
 *
 * `RgMonitoringService.spendFor` still computes the loss limit correctly, so the 80%
 * review flag is right the day payouts start being recorded - and this list is the one
 * line to change then.
 */
const TYPES_BY_MOVE = {
  deposit: ['deposit'],
  wager: ['wager'],
} as const satisfies Record<string, readonly LimitType[]>;

/**
 * The compliance-owned implementation of `RG_LIMITS`. Reads the same `spendFor` windows
 * the 80% monitoring flag reads, so the gate and the dashboard can never disagree about
 * how much of a limit is used.
 *
 * The move being attempted counts: `used + amount > limit` refuses. A limit is a ceiling
 * on the total, not a ceiling on what has already settled.
 */
export class RgLimitGate implements RgLimitsPort {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly monitoring: RgMonitoringService,
  ) {}

  checkDeposit(userId: string, amount: string): Promise<RgLimitDecision> {
    return this.check(userId, TYPES_BY_MOVE.deposit, amount);
  }

  checkWager(userId: string, amount: string): Promise<RgLimitDecision> {
    return this.check(userId, TYPES_BY_MOVE.wager, amount);
  }

  private async check(
    userId: string,
    types: readonly LimitType[],
    amount: string,
  ): Promise<RgLimitDecision> {
    // Money limits only: the session-time limit is minutes, and the sweep owns it.
    const rows = await this.drizzle.db
      .select()
      .from(userLimit)
      .where(and(eq(userLimit.userId, userId), ne(userLimit.period, 'session')));

    const now = new Date();
    for (const row of rows) {
      if (!types.includes(row.type as LimitType) || row.amount === null) {
        continue;
      }
      const period = row.period as LimitPeriod;
      // `amount` is ALWAYS the limit in force. A pending increase the player has not
      // confirmed yet is deliberately not read here - that is the whole point of the
      // cool-down.
      const limit = row.amount;
      // TODO: currency. `spendFor` sums across every currency the player holds and this
      // compares the result to a currency-less limit, so a multi-currency player is
      // gated on an arithmetically wrong total. Fix at the source (add
      // `user_limit.currency`, move the unique index to
      // `(userId, type, period, currency)`, filter both sums by it) - never by guessing
      // a currency here, which breaks silently the moment a player transacts outside it.
      const { from } = periodWindow(period, now);
      const used = await this.monitoring.spendFor(userId, row.type as LimitType, from);
      if (moneyCompare(moneyAdd(used, amount), limit) > 0) {
        return {
          allowed: false,
          limitType: row.type as LimitType,
          period,
          limit,
          // Clamped: an over-limit window would otherwise report a negative headroom.
          used: moneyCompare(used, '0') < 0 ? '0' : used,
        };
      }
    }
    return { allowed: true };
  }
}

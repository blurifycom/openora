import { eq, and, ne } from 'drizzle-orm';
import { moneyAdd, moneyCompare, type DrizzleService } from '@openora/core/server';
import type {
  ExchangeRateReader,
  LimitPeriod,
  LimitType,
  RgLimitDecision,
  RgLimitsPort,
} from '@openora/core/contracts';
import { userLimit } from '../schema/index.js';
import { RgMonitoringService, RgRateUnavailableError } from '../service/rg-monitoring.service.js';
import { resolveLimitCurrency, RgLimitCurrencyUnresolvedError } from '../service/rg.service.js';
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
    private readonly rates: ExchangeRateReader,
  ) {}

  checkDeposit(userId: string, amount: string, currency: string): Promise<RgLimitDecision> {
    return this.check(userId, TYPES_BY_MOVE.deposit, amount, currency);
  }

  checkWager(userId: string, amount: string, currency: string): Promise<RgLimitDecision> {
    return this.check(userId, TYPES_BY_MOVE.wager, amount, currency);
  }

  private async check(
    userId: string,
    types: readonly LimitType[],
    amount: string,
    amountCurrency: string,
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
      const { from } = periodWindow(period, now);

      // Fail-closed sentinel shared by both conversions below: we don't know the true
      // usage, so report it as fully consumed. `moneyAdd(used, amount) > limit` then
      // holds for any positive attempted amount, which is what actually enforces the
      // refusal via the comparison at the end of this loop - no new RgLimitDecision
      // variant needed.
      const rateUnavailable = (): Extract<RgLimitDecision, { allowed: false }> => ({
        allowed: false,
        limitType: row.type as LimitType,
        period,
        limit,
        used: limit,
      });

      // A pre-existing row's null currency resolves (and persists) here on first touch -
      // see resolveLimitCurrency in rg.service.ts. Fails the move closed the same way a
      // missing exchange rate does: an unresolvable currency means this limit cannot be
      // safely evaluated at all.
      let rowCurrency: string;
      try {
        rowCurrency = (await resolveLimitCurrency(this.drizzle, row)).currency;
      } catch (err) {
        if (!(err instanceof RgLimitCurrencyUnresolvedError)) {
          throw err;
        }
        return rateUnavailable();
      }

      // The historical spend, converted into the limit's currency by `spendFor` itself
      // (grouped per source-currency, fail-closed on a missing rate).
      let used: string;
      try {
        used = await this.monitoring.spendFor(
          userId,
          row.type as LimitType,
          period,
          from,
          rowCurrency,
        );
      } catch (err) {
        if (!(err instanceof RgRateUnavailableError)) {
          throw err;
        }
        return rateUnavailable();
      }

      // The NEW amount being attempted also has to land in the limit's currency before
      // it is added to `used` - without this, a 100 BTC deposit against a 0-history 100
      // USD limit would still pass on `used` alone. Same-currency skips the conversion
      // call; a missing/stale rate refuses the move (fail-closed), same as `spendFor`.
      const attempted =
        amountCurrency === rowCurrency
          ? amount
          : await this.rates.convert(amount, amountCurrency, rowCurrency);
      if (attempted === null) {
        return rateUnavailable();
      }

      if (moneyCompare(moneyAdd(used, attempted), limit) > 0) {
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

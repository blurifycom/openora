import { eq, and, ne } from 'drizzle-orm';
import { moneyAdd, moneyCompare, withAdvisoryXactLock, type DrizzleTx } from '@openora/core/server';
import type {
  ExchangeRateReader,
  LimitPeriod,
  LimitType,
  RgLimitDecision,
  RgLimitsPort,
} from '@openora/core/contracts';
import { userLimit } from '../schema/index.js';
import { RgMonitoringService, RgRateUnavailableError } from '../service/rg-monitoring.service.js';
import {
  resolveLimitCurrencyInTx,
  limitSlotKey,
  RgLimitCurrencyUnresolvedError,
} from '../service/rg.service.js';
import { periodWindow } from '../service/rg-eval.js';

const TYPES_BY_MOVE = {
  deposit: ['deposit'],
  wager: ['wager'],
} as const satisfies Record<string, readonly LimitType[]>;

/**
 * The compliance-owned implementation of `RG_LIMITS`.
 *
 * The move being attempted counts: `used + amount > limit` refuses. A limit is a ceiling
 * on the total, not a ceiling on what has already settled.
 */
export class RgLimitGate implements RgLimitsPort {
  constructor(
    private readonly monitoring: RgMonitoringService,
    private readonly rates: ExchangeRateReader,
  ) {}

  checkDeposit(
    tx: unknown,
    userId: string,
    amount: string,
    currency: string,
  ): Promise<RgLimitDecision> {
    return this.check(tx, userId, TYPES_BY_MOVE.deposit, amount, currency);
  }

  checkWager(
    tx: unknown,
    userId: string,
    amount: string,
    currency: string,
  ): Promise<RgLimitDecision> {
    return this.check(tx, userId, TYPES_BY_MOVE.wager, amount, currency);
  }

  private async check(
    tx: unknown,
    userId: string,
    types: readonly LimitType[],
    amount: string,
    amountCurrency: string,
  ): Promise<RgLimitDecision> {
    const txn = tx as DrizzleTx;

    const rows = await txn
      .select()
      .from(userLimit)
      .where(and(eq(userLimit.userId, userId), ne(userLimit.period, 'session')));

    const now = new Date();
    for (const row of rows) {
      if (!types.includes(row.type as LimitType) || row.amount === null) {
        continue;
      }
      const period = row.period as LimitPeriod;
      const limit = row.amount;
      const { from } = periodWindow(period, now);

      const rateUnavailable = (): Extract<RgLimitDecision, { allowed: false }> => ({
        allowed: false,
        limitType: row.type as LimitType,
        period,
        limit,
        used: limit,
      });

      let rowCurrency: string;
      try {
        rowCurrency = (
          await withAdvisoryXactLock(
            txn,
            limitSlotKey(row.userId, row.type as LimitType, period),
            () => resolveLimitCurrencyInTx(txn, row),
          )
        ).currency;
      } catch (err) {
        if (!(err instanceof RgLimitCurrencyUnresolvedError)) {
          throw err;
        }
        return rateUnavailable();
      }

      let used: string;
      try {
        used = await this.monitoring.spendFor(
          txn,
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
          used: moneyCompare(used, '0') < 0 ? '0' : used,
        };
      }
    }
    return { allowed: true };
  }
}

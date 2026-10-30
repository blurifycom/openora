import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import type { ExchangeRateReader } from '@openora/core/contracts';
import { moneyAdd, type DrizzleDb, type DrizzleTx } from '@openora/core/server';
import { promoRakebackAccrual, promoRakebackClaimPayout } from '../schema/index.js';
import type {
  RakebackAccrualStatus,
  RakebackCurrencyAmount,
  RakebackLiability,
} from '../contract/index.js';

type Db = DrizzleDb | DrizzleTx;

export async function rakebackByCurrency(
  db: Db,
  status: RakebackAccrualStatus,
  userId?: string,
): Promise<RakebackCurrencyAmount[]> {
  const conditions: SQL[] = [eq(promoRakebackAccrual.status, status)];
  if (userId) {
    conditions.push(eq(promoRakebackAccrual.userId, userId));
  }
  return db
    .select({
      currency: promoRakebackAccrual.currency,
      amount: sql<string>`sum(${promoRakebackAccrual.amount})::text`,
    })
    .from(promoRakebackAccrual)
    .where(and(...conditions))
    .groupBy(promoRakebackAccrual.currency)
    .orderBy(asc(promoRakebackAccrual.currency));
}

export async function claimedByCurrency(db: Db, userId: string): Promise<RakebackCurrencyAmount[]> {
  return db
    .select({
      currency: promoRakebackClaimPayout.currency,
      amount: sql<string>`sum(${promoRakebackClaimPayout.amount})::text`,
    })
    .from(promoRakebackClaimPayout)
    .where(eq(promoRakebackClaimPayout.userId, userId))
    .groupBy(promoRakebackClaimPayout.currency)
    .orderBy(asc(promoRakebackClaimPayout.currency));
}

/**
 * Prices per-currency amounts into the reference currency. A currency with no rate shows a null
 * reference amount and counts nothing toward the total - it is still paid on a claim.
 */
export async function priceRakeback(
  db: Db,
  rates: ExchangeRateReader,
  referenceCurrency: string,
  amounts: readonly RakebackCurrencyAmount[],
): Promise<RakebackLiability> {
  let referenceTotal = '0';
  const unclaimed = [];
  for (const { currency, amount } of amounts) {
    const referenceAmount =
      currency === referenceCurrency
        ? amount
        : await rates.convert(amount, currency, referenceCurrency, db);
    if (referenceAmount !== null) {
      referenceTotal = moneyAdd(referenceTotal, referenceAmount);
    }
    unclaimed.push({ currency, amount, referenceAmount });
  }
  return { unclaimed, referenceCurrency, referenceTotal };
}

export async function unclaimedRakeback(
  db: Db,
  rates: ExchangeRateReader,
  referenceCurrency: string,
  userId?: string,
): Promise<RakebackLiability> {
  return priceRakeback(
    db,
    rates,
    referenceCurrency,
    await rakebackByCurrency(db, 'accrued', userId),
  );
}

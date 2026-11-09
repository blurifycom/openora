import { dayRangeInstants } from '@openora/core/contracts';
import { moneyAdd, moneySubtract, type DrizzleService } from '@openora/core/server';
import {
  PROMOTION_REPORT_MAX_CURRENCIES,
  PROMOTION_REPORT_MAX_ROWS,
  resolvePromotionReportRange,
  type PromotionReport,
  type PromotionReportInput,
} from '../contract/index.js';
import { promotionReportOf } from './bet-query.service.js';

type Figures = {
  bets: number;
  promotionPaid: string;
  promotionReversed: string;
  net: string;
};

const NONE: Figures = { bets: 0, promotionPaid: '0', promotionReversed: '0', net: '0' };

/**
 * sportsbook.promotion_report: the admin promotions report's rows over whole UTC days, per currency
 * with its totals and each row's net.
 */
export async function promotionReport(
  drizzle: DrizzleService,
  { currency, ...dates }: PromotionReportInput,
  now = new Date(),
): Promise<PromotionReport> {
  const range = resolvePromotionReportRange(dates, now);
  const { from, to } = dayRangeInstants(range);
  const rows = await promotionReportOf(drizzle.db, {
    dateFrom: from.toISOString(),
    dateTo: to.toISOString(),
  });
  const wanted = currency?.toUpperCase();
  const byCurrency = new Map<string, PromotionReport['currencies'][number]>();
  for (const row of rows) {
    if (wanted !== undefined && row.currency !== wanted) {
      continue;
    }
    const figures: Figures = {
      bets: row.bets,
      promotionPaid: row.promotionPaid,
      promotionReversed: row.promotionReversed,
      net: moneySubtract(row.promotionPaid, row.promotionReversed),
    };
    const entry = byCurrency.get(row.currency) ?? {
      currency: row.currency,
      ...NONE,
      promotions: [],
    };
    entry.bets += figures.bets;
    entry.promotionPaid = moneyAdd(entry.promotionPaid, figures.promotionPaid);
    entry.promotionReversed = moneyAdd(entry.promotionReversed, figures.promotionReversed);
    entry.net = moneyAdd(entry.net, figures.net);
    if (entry.promotions.length < PROMOTION_REPORT_MAX_ROWS) {
      entry.promotions.push({ type: row.type, funder: row.funder, ...figures });
    }
    byCurrency.set(row.currency, entry);
  }
  const currencies = [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency));
  return {
    ...range,
    currencies: currencies.slice(0, PROMOTION_REPORT_MAX_CURRENCIES),
    truncated: currencies.length > PROMOTION_REPORT_MAX_CURRENCIES,
  };
}

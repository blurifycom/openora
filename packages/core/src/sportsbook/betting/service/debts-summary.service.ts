import { and, asc, eq, gt, lte, sql } from 'drizzle-orm';
import { sumMoney, type DrizzleService } from '@openora/core/server';
import { player } from '@openora/core/pam/schema/profile';
import {
  DEBTS_MAX_CURRENCIES,
  type DebtsSummary,
  type DebtsSummaryInput,
} from '../contract/index.js';
import { sportsbookPlayerDebt } from '../schema/index.js';
import { holdActiveSql } from './debt.service.js';

/**
 * sportsbook.debts: what players owe the sportsbook now, per currency, and the largest open debts.
 * A reader over DRIZZLE alone: the debt service needs the wallet's and identity's ports, and the
 * kernel builds every tool's handler when it starts.
 */
export class SportsbookDebtsSummaryService {
  constructor(private readonly drizzle: DrizzleService) {}

  async summary({ currency, largest }: DebtsSummaryInput): Promise<DebtsSummary> {
    const debt = sportsbookPlayerDebt;
    const inCurrency = currency ? eq(debt.currency, currency.toUpperCase()) : undefined;
    const open = and(eq(debt.status, 'open'), gt(debt.outstanding, '0'));
    const db = this.drizzle.db;
    const ranked = db
      .select({
        currency: debt.currency,
        debtId: sql<string>`${debt.id}`.as('debt_id'),
        playerId: sql<string | null>`${player.id}`.as('player_id'),
        outstanding: debt.outstanding,
        owed: debt.owed,
        collected: debt.collected,
        openSince: debt.createdAt,
        withdrawalsHeld: holdActiveSql.as('withdrawals_held'),
        // The debt id breaks ties, so equal amounts always rank in the same order.
        rank: sql<number>`row_number() over (partition by ${debt.currency} order by ${debt.outstanding} desc, ${debt.id})`.as(
          'rank',
        ),
      })
      .from(debt)
      .leftJoin(player, eq(player.userId, debt.userId))
      .where(and(open, inCurrency))
      .as('ranked');
    const [totals, largestRows] = await Promise.all([
      db
        .select({
          currency: debt.currency,
          openDebts: sql<number>`count(*) filter (where ${open})`.mapWith(Number),
          outstanding: sumMoney(debt.outstanding, open),
          owed: sumMoney(debt.owed),
          collected: sumMoney(debt.collected),
          writtenOff: sumMoney(debt.writtenOff),
        })
        .from(debt)
        .where(inCurrency)
        .groupBy(debt.currency)
        .orderBy(asc(debt.currency))
        .limit(DEBTS_MAX_CURRENCIES + 1),
      largest === 0
        ? Promise.resolve([])
        : db
            .select()
            .from(ranked)
            .where(lte(ranked.rank, largest))
            .orderBy(asc(ranked.currency), asc(ranked.rank)),
    ]);
    return {
      currencies: totals.slice(0, DEBTS_MAX_CURRENCIES).map((row) => ({
        ...row,
        largestOpen: largestRows
          .filter((entry) => entry.currency === row.currency)
          .map((entry) => ({
            debtId: entry.debtId,
            playerId: entry.playerId,
            outstanding: entry.outstanding,
            owed: entry.owed,
            collected: entry.collected,
            openSince: new Date(entry.openSince).toISOString(),
            withdrawalsHeld: Boolean(entry.withdrawalsHeld),
          })),
      })),
      truncated: totals.length > DEBTS_MAX_CURRENCIES,
    };
  }
}

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { findOneOrThrow, moneyAdd, moneyCompare, moneyScaleBy } from '@openora/core/server';
import { migrate as migrateOutbox } from '@openora/core/server/migrate';
import {
  WalletTurnoverConfigSchema,
  definePlatformConfig,
  type ExchangeRateReader,
  type PlayEligibilityPort,
  type WagerProduct,
} from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { makeAuditWriter, makeOutboxEventBus, mock } from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { wallet, walletBalance, walletTransaction, walletTurnover } from '../schema/index.js';
import { TurnoverService } from '../service/turnover.service.js';
import { WalletCommandsService } from '../service/wallet-commands.service.js';

let db: TestDb;
let turnover: TurnoverService;
let commands: WalletCommandsService;

const reader = mock<ExchangeRateReader>({
  getRate: vi.fn(async () => null),
  convert: vi.fn(async (amount: string) => moneyScaleBy(amount, '1')),
});
const eligibility = mock<PlayEligibilityPort>({
  isRestricted: vi.fn().mockResolvedValue(false),
  checkPlay: vi.fn().mockResolvedValue(null),
});

beforeAll(async () => {
  db = await createTestDb([migrateOutbox, migrate]);
  turnover = new TurnoverService({
    drizzle: db.drizzle,
    events: makeOutboxEventBus(),
    audit: makeAuditWriter(),
    config: WalletTurnoverConfigSchema.parse({ multiplier: '1' }),
    pivotCurrency: 'USD',
    rates: reader,
  });
  commands = new WalletCommandsService(eligibility, makeAuditWriter(), {
    platformConfig: definePlatformConfig({
      wallet: { turnover: { multiplier: '1' }, transferCredits: 'cash' },
    }),
    turnover: () => turnover,
  });
});

afterAll(async () => {
  await db.drop();
});

const expectMoney = (actual: string | null | undefined, expected: string, label: string) =>
  expect(moneyCompare(String(actual), expected) === 0, `${label}: ${String(actual)}`).toBe(true);

async function player(amount = '1000') {
  const userId = randomUUID();
  const row = findOneOrThrow(
    await db.drizzle.db.insert(wallet).values({ userId, currency: 'USD' }).returning(),
    new Error('seed wallet: no row'),
  );
  await db.drizzle.db.insert(walletBalance).values({ walletId: row.id, currency: 'USD', amount });
  return { userId, walletId: row.id };
}

const balanceOf = async (walletId: string) =>
  findOneOrThrow(
    await db.drizzle.db.select().from(walletBalance).where(eq(walletBalance.walletId, walletId)),
    new Error('balance missing'),
  ).amount;

const progressOf = async (userId: string) =>
  (await db.drizzle.db.select().from(walletTurnover).where(eq(walletTurnover.userId, userId)))[0]
    ?.progress ?? '0';

const owe = (userId: string, amount = '1000') =>
  db.drizzle.db.transaction((tx) =>
    turnover.addCredit(tx, {
      userId,
      kind: 'deposit',
      sourceRef: randomUUID(),
      currency: 'USD',
      amount,
    }),
  );

const bet = (
  userId: string,
  amount: string,
  product: WagerProduct = 'casino',
  round = randomUUID(),
) =>
  db.drizzle.db.transaction(async (tx) => {
    const outcome = await commands.debit(tx, {
      userId,
      amount,
      currency: 'USD',
      type: 'bet',
      providerRef: { providerName: 'agg', providerRefId: randomUUID(), externalRoundId: round },
      context: { provider: 'agg', product },
    });
    if (!outcome.ok || !outcome.moved) {
      throw new Error('bet did not move');
    }
    return { id: outcome.transactionId, round };
  });

const win = (userId: string, round: string, amount = '1') =>
  db.drizzle.db.transaction((tx) =>
    commands.credit(tx, {
      userId,
      amount,
      currency: 'USD',
      type: 'win',
      closesRound: true,
      providerRef: { providerName: 'agg', providerRefId: randomUUID(), externalRoundId: round },
    }),
  );

const reverse = (userId: string, placed: { id: string; round: string }, amount: string) =>
  db.drizzle.db.transaction((tx) =>
    commands.credit(tx, {
      userId,
      amount,
      currency: 'USD',
      type: 'bet_reversal',
      providerRef: {
        providerName: 'agg',
        providerRefId: randomUUID(),
        externalRoundId: placed.round,
      },
      reversesTransactionId: placed.id,
    }),
  );

const clear = (userId: string) => turnover.clear(randomUUID(), { userId, reason: 'goodwill' });

const countedAfterClear = async (userId: string, walletId: string) => {
  const rows = await db.drizzle.db
    .select({
      amount: walletTransaction.amount,
      state: walletTransaction.turnoverState,
      contribution: walletTransaction.turnoverContribution,
      type: walletTransaction.type,
      afterClear: sql<boolean>`${walletTransaction.createdAt} > coalesce((select ${walletTurnover.clearedAt} from ${walletTurnover} where ${walletTurnover.userId} = ${userId}), '-infinity')`,
    })
    .from(walletTransaction)
    .where(and(eq(walletTransaction.walletId, walletId), eq(walletTransaction.type, 'bet')));
  return rows
    .filter(({ state, afterClear }) => state === 'counted' && afterClear)
    .reduce((sum, { contribution }) => moneyAdd(sum, contribution ?? '0'), '0');
};

describe('a win closing a sportsbook round racing a staff clear', () => {
  it('counts a stake only when it was placed after the clear, however the settle interleaves', async () => {
    for (let run = 0; run < 25; run += 1) {
      const { userId, walletId } = await player();
      await owe(userId);
      const early = await bet(userId, '9', 'sportsbook');
      const results = await Promise.allSettled([
        win(userId, early.round),
        clear(userId),
        owe(userId),
        bet(userId, '4', 'sportsbook'),
        bet(userId, '6', 'casino'),
      ]);
      expect(results.filter(({ status }) => status === 'rejected')).toEqual([]);
      const progress = await progressOf(userId);
      expect(moneyCompare(progress, '0') >= 0, `run ${run} progress ${progress}`).toBe(true);
      const sports = await db.drizzle.db
        .select({
          round: walletTransaction.externalRoundId,
          state: walletTransaction.turnoverState,
        })
        .from(walletTransaction)
        .where(and(eq(walletTransaction.walletId, walletId), eq(walletTransaction.type, 'bet')));
      for (const { round, state } of sports) {
        if (state === 'deferred' && round) {
          await db.drizzle.db.transaction((tx) =>
            commands.closeRound(tx, {
              userId,
              currency: 'USD',
              providerRef: { providerName: 'agg', externalRoundId: round },
            }),
          );
        }
      }
      expectMoney(
        await progressOf(userId),
        await countedAfterClear(userId, walletId),
        `run ${run} progress equals post-clear counted stakes`,
      );
    }
  });
});

describe('bet, reversal, clear, deposit credit and withdrawal for one player together', () => {
  it('never deadlocks, never goes negative and keeps the balance whole', async () => {
    for (let run = 0; run < 40; run += 1) {
      const { userId, walletId } = await player('1000');
      await owe(userId);
      const seeded = await bet(userId, '10');
      const results = await Promise.allSettled([
        bet(userId, '5'),
        bet(userId, '7', 'sportsbook'),
        reverse(userId, seeded, '10'),
        clear(userId),
        owe(userId, '50'),
        db.drizzle.db
          .transaction((tx) =>
            commands.debit(tx, {
              userId,
              amount: '20',
              currency: 'USD',
              type: 'withdrawal',
              providerRef: { providerName: 'psp', providerRefId: randomUUID() },
            }),
          )
          .catch((error: unknown) => {
            if (error instanceof Error && error.name === 'TurnoverLockedError') {
              return null;
            }
            throw error;
          }),
        bet(userId, '3'),
        clear(userId),
        owe(userId, '25'),
      ]);
      expect(
        results
          .filter(({ status }) => status === 'rejected')
          .map((r) => String((r as PromiseRejectedResult).reason)),
        `run ${run}`,
      ).toEqual([]);
      const progress = await progressOf(userId);
      expect(moneyCompare(progress, '0') >= 0, `run ${run} progress ${progress}`).toBe(true);
      const balance = await balanceOf(walletId);
      expect(
        moneyCompare(balance, '0') >= 0 && moneyCompare(balance, '1000') <= 0,
        `run ${run} balance ${balance}`,
      ).toBe(true);
    }
  });
});

describe('a rain shaped transfer', () => {
  it('takes overlapping recipient sets from concurrent senders without a deadlock and conserves money', async () => {
    const senders = await Promise.all([player('1000'), player('1000')]);
    const recipients = await Promise.all(Array.from({ length: 20 }, () => player('0')));
    const all = [...senders, ...recipients];
    const total = async () => {
      let sum = '0';
      for (const { walletId } of all) {
        sum = moneyAdd(sum, await balanceOf(walletId));
      }
      return sum;
    };
    const rain = (sender: { userId: string }, picks: typeof recipients) =>
      db.drizzle.db.transaction(async (tx) => {
        await commands.lockWallets?.(tx, {
          userIds: [sender.userId, ...picks.map((p) => p.userId)],
        });
        const ref = randomUUID();
        await commands.debit(tx, {
          userId: sender.userId,
          amount: String(picks.length),
          currency: 'USD',
          type: 'rain',
          providerRef: { providerName: 'rain', providerRefId: ref },
        });
        for (const [index, pick] of picks.entries()) {
          await commands.credit(tx, {
            userId: pick.userId,
            amount: '1',
            currency: 'USD',
            type: 'rain',
            providerRef: { providerName: 'rain', providerRefId: `${ref}:${index}` },
          });
        }
      });

    for (let run = 0; run < 8; run += 1) {
      const before = await total();
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, (_, i) => {
          const picks = recipients
            .filter((_r, j) => (j + i * 3 + run) % 3 !== 0)
            .slice(i % 2 === 0 ? 0 : 4);
          return rain(senders[i % 2] as { userId: string }, picks.length > 0 ? picks : recipients);
        }),
      );
      expect(
        results
          .filter(({ status }) => status === 'rejected')
          .map((r) => String((r as PromiseRejectedResult).reason)),
        `run ${run}`,
      ).toEqual([]);
      expectMoney(await total(), before, `run ${run} total`);
    }
  });
});

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, gte, inArray, like, sql, sum, type SQLWrapper } from 'drizzle-orm';
import { findOneOrThrow, type DrizzleDb, type DrizzleTx } from '@openora/core/server';
import type { WalletWindowMetric, WalletWindowTotals } from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate } from '../migrate.js';
import { LOSS_LEGS, wallet, walletTransaction } from '../schema/index.js';
import { WalletReaderService } from '../adapters/wallet-reader.service.js';

// The queries compliance, player management and sportsbook ran on the wallet tables before they
// moved behind WALLET_READER, kept verbatim as oracles: each reader method must answer what its
// old query did, on the caller's transaction where the old query ran on one.

type Db = DrizzleDb | DrizzleTx;

function oldDepositsByCurrency(db: Db, userId: string) {
  return db
    .select({
      currency: walletTransaction.currency,
      total: sql<string>`coalesce(sum(${walletTransaction.amount}), 0)`,
    })
    .from(walletTransaction)
    .innerJoin(wallet, eq(wallet.id, walletTransaction.walletId))
    .where(
      and(
        eq(wallet.userId, userId),
        eq(walletTransaction.type, 'deposit'),
        eq(walletTransaction.status, 'completed'),
      ),
    )
    .groupBy(walletTransaction.currency);
}

function oldTotalsSince(amount: SQLWrapper, countedAt: SQLWrapper, windowStarts: readonly Date[]) {
  const totals = windowStarts.map(
    (start) =>
      sql`greatest(coalesce(sum(${amount}) filter (where ${countedAt} >= ${start}), 0), 0)::text`,
  );
  return sql<string[]>`array[${sql.join(totals, sql`, `)}]`;
}

async function oldMoneyByWindow(
  tx: Db,
  userId: string,
  windowStarts: readonly Date[],
): Promise<WalletWindowTotals[]> {
  const earliest = windowStarts.reduce<Date | null>(
    (min, start) => (min === null || start < min ? start : min),
    null,
  );
  if (earliest === null) {
    return [];
  }
  const depositedAt = sql`coalesce(${walletTransaction.reviewedAt}, ${walletTransaction.createdAt})`;
  const deposits = await tx
    .select({
      currency: walletTransaction.currency,
      totals: oldTotalsSince(walletTransaction.amount, depositedAt, windowStarts),
    })
    .from(walletTransaction)
    .innerJoin(wallet, eq(wallet.id, walletTransaction.walletId))
    .where(
      and(
        eq(wallet.userId, userId),
        eq(walletTransaction.type, 'deposit'),
        eq(walletTransaction.status, 'completed'),
        gte(depositedAt, earliest),
      ),
    )
    .groupBy(walletTransaction.currency);
  const metric = sql<WalletWindowMetric>`case when ${walletTransaction.type} in ('win', 'win_reversal') then 'wins' else 'bets' end`;
  const signedAmount = sql`case when ${walletTransaction.type} in ('bet_reversal', 'win_reversal') then -${walletTransaction.amount} else ${walletTransaction.amount} end`;
  const play = await tx
    .select({
      metric,
      currency: walletTransaction.currency,
      totals: oldTotalsSince(signedAmount, walletTransaction.createdAt, windowStarts),
    })
    .from(walletTransaction)
    .innerJoin(wallet, eq(wallet.id, walletTransaction.walletId))
    .where(
      and(
        eq(wallet.userId, userId),
        eq(walletTransaction.status, 'completed'),
        inArray(
          walletTransaction.type,
          LOSS_LEGS.map((leg) => leg.type),
        ),
        gte(walletTransaction.createdAt, earliest),
      ),
    )
    .groupBy(metric, walletTransaction.currency);
  return [...deposits.map((row) => ({ ...row, metric: 'deposits' as const })), ...play];
}

async function oldHasWallet(tx: Db, userId: string): Promise<boolean> {
  const [row] = await tx.select({ id: wallet.id }).from(wallet).where(eq(wallet.userId, userId));
  return row !== undefined;
}

async function oldCollected(tx: Db, providerName: string, roundId: string, id: string) {
  const [taken] = await tx
    .select({ total: sum(walletTransaction.amount) })
    .from(walletTransaction)
    .where(
      and(
        eq(walletTransaction.externalRoundId, roundId),
        eq(walletTransaction.providerName, providerName),
        eq(walletTransaction.type, 'win_reversal'),
        eq(walletTransaction.status, 'completed'),
        like(walletTransaction.providerRefId, `%:${id}`),
      ),
    );
  return taken?.total ?? '0';
}

const byKey = <T extends { currency: string; metric?: string }>(rows: readonly T[]) =>
  [...rows].sort((a, b) =>
    `${a.metric ?? ''}:${a.currency}`.localeCompare(`${b.metric ?? ''}:${b.currency}`),
  );

let db: TestDb;
let reader: WalletReaderService;

const ago = (ms: number) => new Date(Date.now() - ms);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PROVIDER = 'sportsbook:feed-a';
const ROUND = 'round-1';

type Row = Omit<typeof walletTransaction.$inferInsert, 'walletId'>;

async function seedWallet(userId: string, rows: Row[]) {
  const { id } = findOneOrThrow(
    await db.drizzle.db.insert(wallet).values({ userId, currency: 'USD' }).returning(),
    new Error('seedWallet: no wallet row'),
  );
  for (const row of rows) {
    await db.drizzle.db.insert(walletTransaction).values({ walletId: id, ...row });
  }
  return id;
}

const done = 'completed' as const;

beforeAll(async () => {
  db = await createTestDb([migrate]);
  reader = new WalletReaderService({ drizzle: db.drizzle, pivotCurrency: 'USD' });
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${walletTransaction}, ${wallet} RESTART IDENTITY CASCADE`,
  );
});

describe('WalletReaderService parity with the reads it replaced (real PG)', () => {
  const userId = randomUUID();
  const debtId = randomUUID();
  const windowStarts = [ago(HOUR), ago(DAY), ago(30 * DAY)];

  beforeEach(async () => {
    await seedWallet(userId, [
      { type: 'deposit', status: done, amount: '100', currency: 'USD', createdAt: ago(2 * DAY) },
      {
        type: 'deposit',
        status: done,
        amount: '50.5',
        currency: 'USD',
        createdAt: ago(10 * 60_000),
      },
      { type: 'deposit', status: done, amount: '0.25', currency: 'BTC', createdAt: ago(3 * HOUR) },
      // Held 40 days, released an hour ago: counts from its release.
      {
        type: 'deposit',
        status: done,
        amount: '7',
        currency: 'USD',
        createdAt: ago(40 * DAY),
        reviewedAt: ago(30 * 60_000),
      },
      { type: 'deposit', status: done, amount: '9', currency: 'ETH', createdAt: ago(60 * DAY) },
      { type: 'deposit', status: 'pending', amount: '999', currency: 'USD' },
      { type: 'deposit', status: 'failed', amount: '11', currency: 'USD' },
      { type: 'withdrawal', status: done, amount: '30', currency: 'USD' },
      { type: 'bet', status: done, amount: '20', currency: 'USD', createdAt: ago(2 * DAY) },
      { type: 'bet', status: done, amount: '5', currency: 'USD', createdAt: ago(30 * 60_000) },
      // Reverses the 2-day-old stake inside the last hour: that window's stakes stop at zero.
      {
        type: 'bet_reversal',
        status: done,
        amount: '20',
        currency: 'USD',
        createdAt: ago(5 * 60_000),
      },
      { type: 'bet', status: done, amount: '0.1', currency: 'BTC', createdAt: ago(2 * HOUR) },
      { type: 'bet', status: 'pending', amount: '1000', currency: 'USD' },
      { type: 'win', status: done, amount: '15', currency: 'USD', createdAt: ago(20 * 60_000) },
      // A debt collection is a completed win_reversal tagged with the shortfall id.
      {
        type: 'win_reversal',
        status: done,
        amount: '4',
        currency: 'USD',
        createdAt: ago(15 * 60_000),
        providerName: PROVIDER,
        externalRoundId: ROUND,
        providerRefId: `collect:1:${debtId}`,
      },
      {
        type: 'win_reversal',
        status: done,
        amount: '2.5',
        currency: 'USD',
        providerName: PROVIDER,
        externalRoundId: ROUND,
        providerRefId: `collect:2:${debtId}`,
      },
      {
        type: 'win_reversal',
        status: 'pending',
        amount: '100',
        currency: 'USD',
        providerName: PROVIDER,
        externalRoundId: ROUND,
        providerRefId: `collect:3:${debtId}`,
      },
      {
        type: 'win_reversal',
        status: done,
        amount: '3',
        currency: 'USD',
        providerName: PROVIDER,
        externalRoundId: ROUND,
        providerRefId: `collect:1:${randomUUID()}`,
      },
      {
        type: 'win_reversal',
        status: done,
        amount: '6',
        currency: 'USD',
        providerName: 'sportsbook:feed-b',
        externalRoundId: ROUND,
        providerRefId: `collect:4:${debtId}`,
      },
      {
        type: 'win_reversal',
        status: done,
        amount: '8',
        currency: 'USD',
        providerName: PROVIDER,
        externalRoundId: 'round-2',
        providerRefId: `collect:5:${debtId}`,
      },
    ]);
    // Another player's money never leaks into this one's.
    await seedWallet(randomUUID(), [
      { type: 'deposit', status: done, amount: '500', currency: 'USD' },
      { type: 'bet', status: done, amount: '40', currency: 'USD' },
    ]);
  });

  it('deposits by currency: the KYC gate, KYC re-verification and player total read', async () => {
    const expected = await oldDepositsByCurrency(db.drizzle.db, userId);

    expect(byKey(await reader.getDepositsByCurrency(userId))).toEqual(byKey(expected));
    expect(expected.length).toBe(3);
    expect(await reader.getDepositsByCurrency(randomUUID())).toEqual([]);
  });

  it('money by window: the RG standing read', async () => {
    const expected = await oldMoneyByWindow(db.drizzle.db, userId, windowStarts);

    expect(byKey(await reader.getMoneyByWindow(userId, windowStarts))).toEqual(byKey(expected));
    expect(expected.map((row) => row.metric).sort()).toEqual([
      'bets',
      'bets',
      'deposits',
      'deposits',
      'wins',
    ]);
    expect(await reader.getMoneyByWindow(userId, [])).toEqual([]);
  });

  it('has wallet: the sportsbook reserve read', async () => {
    const stranger = randomUUID();

    expect(await reader.hasWallet(userId, db.drizzle.db)).toBe(
      await oldHasWallet(db.drizzle.db, userId),
    );
    expect(await reader.hasWallet(stranger, db.drizzle.db)).toBe(
      await oldHasWallet(db.drizzle.db, stranger),
    );
    expect(await reader.hasWallet(userId, db.drizzle.db)).toBe(true);
    expect(await reader.hasWallet(stranger, db.drizzle.db)).toBe(false);
  });

  it('provider transaction sum: the sportsbook debt collection read', async () => {
    const query = {
      providerName: PROVIDER,
      externalRoundId: ROUND,
      type: 'win_reversal' as const,
      providerRefSuffix: debtId,
    };
    const unknown = { ...query, providerRefSuffix: randomUUID() };

    expect(await reader.sumProviderTransactions(query, db.drizzle.db)).toBe(
      await oldCollected(db.drizzle.db, PROVIDER, ROUND, debtId),
    );
    expect(await reader.sumProviderTransactions(unknown, db.drizzle.db)).toBe(
      await oldCollected(db.drizzle.db, PROVIDER, ROUND, unknown.providerRefSuffix),
    );
    expect(Number(await reader.sumProviderTransactions(query, db.drizzle.db))).toBe(6.5);
    expect(await reader.sumProviderTransactions(unknown, db.drizzle.db)).toBe('0');
    const wildcard = { ...query, providerRefSuffix: '%' };
    const oneCharWildcard = { ...query, providerRefSuffix: `_${debtId.slice(1)}` };
    expect(Number(await oldCollected(db.drizzle.db, PROVIDER, ROUND, '%'))).toBeGreaterThan(0);
    expect(await reader.sumProviderTransactions(wildcard, db.drizzle.db)).toBe('0');
    expect(await reader.sumProviderTransactions(oneCharWildcard, db.drizzle.db)).toBe('0');
  });

  it('reads on the caller transaction, seeing its uncommitted writes as the old reads did', async () => {
    const newcomer = randomUUID();

    await db.drizzle.db.transaction(async (tx) => {
      const [created] = await tx.insert(wallet).values({ userId: newcomer }).returning();
      await tx.insert(walletTransaction).values([
        { walletId: created!.id, type: 'deposit', status: done, amount: '12', currency: 'USD' },
        { walletId: created!.id, type: 'bet', status: done, amount: '3', currency: 'USD' },
        {
          walletId: created!.id,
          type: 'win_reversal',
          status: done,
          amount: '1',
          currency: 'USD',
          providerName: PROVIDER,
          externalRoundId: 'round-tx',
          providerRefId: `collect:9:${debtId}`,
        },
      ]);

      expect(await reader.hasWallet(newcomer, tx)).toBe(await oldHasWallet(tx, newcomer));
      expect(await reader.hasWallet(newcomer, tx)).toBe(true);
      expect(await reader.getDepositsByCurrency(newcomer, tx)).toEqual(
        await oldDepositsByCurrency(tx, newcomer),
      );
      expect(byKey(await reader.getMoneyByWindow(newcomer, windowStarts, tx))).toEqual(
        byKey(await oldMoneyByWindow(tx, newcomer, windowStarts)),
      );
      const query = {
        providerName: PROVIDER,
        externalRoundId: 'round-tx',
        type: 'win_reversal' as const,
        providerRefSuffix: debtId,
      };
      expect(await reader.sumProviderTransactions(query, tx)).toBe(
        await oldCollected(tx, PROVIDER, 'round-tx', debtId),
      );
      expect(Number(await reader.sumProviderTransactions(query, tx))).toBe(1);
    });
  });
});

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../../testing/real-infra.js';
import { migrate } from '../migrate.js';
import { wallet, walletBalance, walletTransaction } from '../schema/index.js';
import { WalletReaderService } from '../adapters/wallet-reader.service.js';

type Insert = typeof walletTransaction.$inferInsert;

const DAY_MS = 24 * 60 * 60 * 1000;

let testDb: TestDb;
let reader: WalletReaderService;

beforeAll(async () => {
  testDb = await createTestDb([migrate]);
  reader = new WalletReaderService({ drizzle: testDb.drizzle, pivotCurrency: 'USD' });
}, 120_000);

afterAll(() => testDb.drop());

const db = () => testDb.drizzle.db;
type Executor = Pick<ReturnType<typeof db>, 'insert' | 'select'>;

const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

async function seedWallet(userId: string, executor: Executor = db(), currency = 'USD') {
  const [row] = await executor.insert(wallet).values({ userId, currency }).returning();
  if (!row) {
    throw new Error('wallet insert returned no row');
  }
  return row;
}

async function seedBalance(walletId: string, currency: string, amount: string) {
  await db().insert(walletBalance).values({ walletId, currency, amount });
}

async function seedTransaction(
  walletId: string,
  overrides: Partial<Insert> & Pick<Insert, 'type' | 'amount'>,
  executor: Executor = db(),
) {
  const [row] = await executor
    .insert(walletTransaction)
    .values({ walletId, currency: 'USD', status: 'completed', ...overrides })
    .returning();
  if (!row) {
    throw new Error('transaction insert returned no row');
  }
  return row;
}

async function seededPlayer() {
  const userId = randomUUID();
  const owned = await seedWallet(userId);
  return { userId, walletId: owned.id };
}

const rawRows = async <T extends Record<string, unknown>>(query: ReturnType<typeof sql>) =>
  (await db().execute<T>(query)).rows;

describe('wallet reader parity', () => {
  it('every WALLET_READER method returns what its original table query returns for the same seeded player, on the pool', async () => {
    const { userId, walletId } = await seededPlayer();
    await seedBalance(walletId, 'USD', '125.5');
    await seedBalance(walletId, 'EUR', '7');
    const firstDeposit = await seedTransaction(walletId, {
      type: 'deposit',
      amount: '40',
      createdAt: daysAgo(5),
    });
    const lastDeposit = await seedTransaction(walletId, {
      type: 'deposit',
      amount: '60',
      createdAt: daysAgo(2),
    });
    await seedTransaction(walletId, { type: 'deposit', amount: '99', status: 'pending' });
    await seedTransaction(walletId, { type: 'bet', amount: '30', createdAt: daysAgo(1) });
    await seedTransaction(walletId, { type: 'bet_reversal', amount: '10', createdAt: daysAgo(1) });
    await seedTransaction(walletId, { type: 'withdrawal', amount: '5', createdAt: daysAgo(3) });
    await seedTransaction(walletId, { type: 'withdrawal', amount: '8', createdAt: daysAgo(90) });
    const referenced = await seedTransaction(walletId, {
      type: 'bet',
      amount: '1',
      providerName: 'parity-provider',
      providerRefId: `ref-${randomUUID()}`,
    });

    const [rawDeposits] = await rawRows<{ total: string }>(
      sql`select sum(t.amount)::text as total from wallet_transaction t join wallet w on w.id = t.wallet_id
          where w.user_id = ${userId} and t.type = 'deposit' and t.status = 'completed'`,
    );
    const [rawWithdrawals] = await rawRows<{ n: string }>(
      sql`select count(*)::text as n from wallet_transaction t join wallet w on w.id = t.wallet_id
          where w.user_id = ${userId} and t.type = 'withdrawal' and t.status = 'completed'
            and t.created_at > now() - interval '30 days'`,
    );
    const [rawTurnover] = await rawRows<{ total: string }>(
      sql`select greatest(sum(case when t.type = 'bet' then t.amount else -t.amount end), 0)::text as total
          from wallet_transaction t join wallet w on w.id = t.wallet_id
          where w.user_id = ${userId} and t.type in ('bet', 'bet_reversal') and t.status = 'completed'
            and t.created_at >= now() - interval '7 days'`,
    );
    const [rawBalance] = await rawRows<{ amount: string }>(
      sql`select b.amount::text as amount from wallet_balance b join wallet w on w.id = b.wallet_id
          where w.user_id = ${userId} and b.currency = w.currency`,
    );

    expect(await reader.getBalances(userId)).toEqual({
      activeCurrency: 'USD',
      balances: [
        { currency: 'EUR', balance: '7.000000000000000000' },
        { currency: 'USD', balance: '125.500000000000000000' },
      ],
    });
    expect(await reader.getBalance(userId)).toEqual({
      balance: rawBalance?.amount,
      currency: 'USD',
    });
    expect(await reader.getDepositsByCurrency(userId)).toEqual([
      { currency: 'USD', total: rawDeposits?.total },
    ]);
    expect(await reader.getLifetimeDeposit(userId)).toBe('100.000000000000000000');
    expect(await reader.getWithdrawalCountInWindow(userId, 30)).toBe(Number(rawWithdrawals?.n));
    expect(await reader.getTurnoverSince(userId, daysAgo(7))).toBe(rawTurnover?.total);
    expect(await reader.getLastDeposit(userId)).toMatchObject({
      transactionId: lastDeposit.id,
      amount: lastDeposit.amount,
      currency: 'USD',
    });
    expect(await reader.isFirstDeposit(userId, firstDeposit.id)).toBe(true);
    expect(await reader.isFirstDeposit(userId, lastDeposit.id)).toBe(false);
    expect(
      await reader.findByProviderRef('parity-provider', referenced.providerRefId ?? ''),
    ).toMatchObject({
      id: referenced.id,
      userId,
      amount: referenced.amount,
    });
    expect(await reader.hasWallet(userId, db())).toBe(true);
  });

  it('every WALLET_READER method that takes a transaction sees uncommitted rows when it is given the caller transaction', async () => {
    const userId = randomUUID();
    const providerName = 'tx-provider';
    const externalRoundId = `round-${randomUUID()}`;

    await db().transaction(async (tx) => {
      const owned = await seedWallet(userId, tx);
      await tx.insert(walletBalance).values({ walletId: owned.id, currency: 'USD', amount: '15' });
      const deposit = await seedTransaction(owned.id, { type: 'deposit', amount: '15' }, tx);
      await seedTransaction(
        owned.id,
        {
          type: 'bet',
          amount: '4',
          providerName,
          externalRoundId,
          providerRefId: 'bet:ref-1',
        },
        tx,
      );
      const since = daysAgo(1);

      expect(await reader.hasWallet(userId, tx)).toBe(true);
      expect(await reader.getBalances(userId, tx)).toEqual({
        activeCurrency: 'USD',
        balances: [{ currency: 'USD', balance: '15.000000000000000000' }],
      });
      expect(await reader.getDepositsByCurrency(userId, tx)).toEqual([
        { currency: 'USD', total: '15.000000000000000000' },
      ]);
      expect(await reader.getLifetimeDeposit(userId, tx)).toBe('15.000000000000000000');
      expect(await reader.isFirstDeposit(userId, deposit.id, tx)).toBe(true);
      expect(await reader.getMoneyByWindow(userId, [since], tx)).toEqual(
        expect.arrayContaining([
          { metric: 'deposits', currency: 'USD', totals: ['15.000000000000000000'] },
          { metric: 'bets', currency: 'USD', totals: ['4.000000000000000000'] },
        ]),
      );
      expect(
        await reader.sumProviderTransactions(
          { providerName, externalRoundId, type: 'bet', providerRefSuffix: 'ref-1' },
          tx,
        ),
      ).toBe('4.000000000000000000');

      expect(await reader.hasWallet(userId, db())).toBe(false);
      expect(await reader.getDepositsByCurrency(userId)).toEqual([]);
      expect((await reader.getBalances(userId)).balances).toEqual([]);
    });

    expect(await reader.hasWallet(userId, db())).toBe(true);
  });

  it('getBalance and getBalances return zero balances, never null, for a player with no wallet rows', async () => {
    const userId = randomUUID();

    expect(await reader.getBalances(userId)).toEqual({ activeCurrency: 'USD', balances: [] });
    expect(await reader.getBalance(userId)).toEqual({ balance: '0', currency: 'USD' });
    expect(await reader.getDepositsByCurrency(userId)).toEqual([]);
    expect(await reader.getLifetimeDeposit(userId)).toBe('0');
  });

  it('getMoneyByWindow and getTurnoverSince count only rows from the window start on, with the start included', async () => {
    const { userId, walletId } = await seededPlayer();
    const start = new Date(Date.now() - 2 * DAY_MS);
    await seedTransaction(walletId, {
      type: 'bet',
      amount: '1',
      createdAt: new Date(start.getTime() - 1),
    });
    await seedTransaction(walletId, { type: 'bet', amount: '2', createdAt: start });
    await seedTransaction(walletId, {
      type: 'bet',
      amount: '4',
      createdAt: new Date(start.getTime() + 1),
    });

    const windows = await reader.getMoneyByWindow(userId, [start, new Date(start.getTime() + 1)]);

    expect(windows).toEqual([
      { metric: 'bets', currency: 'USD', totals: ['6.000000000000000000', '4.000000000000000000'] },
    ]);
    expect(await reader.getTurnoverSince(userId, start)).toBe('6.000000000000000000');
    expect(await reader.getTurnoverSince(userId, new Date(start.getTime() + 2))).toBe('0');
  });

  it('getWithdrawalCountInWindow and getWithdrawalCountsInWindow agree for the same players and window', async () => {
    const busy = await seededPlayer();
    const quiet = await seededPlayer();
    const idle = await seededPlayer();
    await seedTransaction(busy.walletId, {
      type: 'withdrawal',
      amount: '3',
      createdAt: daysAgo(1),
    });
    await seedTransaction(busy.walletId, {
      type: 'withdrawal',
      amount: '3',
      createdAt: daysAgo(10),
    });
    await seedTransaction(busy.walletId, {
      type: 'withdrawal',
      amount: '3',
      createdAt: daysAgo(45),
    });
    await seedTransaction(busy.walletId, {
      type: 'withdrawal',
      amount: '3',
      status: 'pending',
      createdAt: daysAgo(1),
    });
    await seedTransaction(quiet.walletId, {
      type: 'withdrawal',
      amount: '3',
      createdAt: daysAgo(2),
    });
    const players = [busy, quiet, idle];

    const batch = await reader.getWithdrawalCountsInWindow(
      players.map((player) => player.userId),
      30,
    );
    const singles = await Promise.all(
      players.map((player) => reader.getWithdrawalCountInWindow(player.userId, 30)),
    );

    expect(singles).toEqual([2, 1, 0]);
    expect(players.map((player) => batch.get(player.userId) ?? 0)).toEqual(singles);
    expect(batch.has(idle.userId)).toBe(false);
  });

  it('findOwnProviderTransaction returns nothing for a provider reference that belongs to another player', async () => {
    const owner = await seededPlayer();
    const other = await seededPlayer();
    const row = await seedTransaction(owner.walletId, {
      type: 'bet',
      amount: '2',
      providerName: 'own-provider',
      providerRefId: `ref-${randomUUID()}`,
    });
    const unreferenced = await seedTransaction(other.walletId, { type: 'bet', amount: '2' });

    expect(await reader.findOwnProviderTransaction(other.userId, row.id)).toBeNull();
    expect(await reader.findOwnProviderTransaction(other.userId, unreferenced.id)).toBeNull();
    expect(await reader.findOwnProviderTransaction(owner.userId, row.id)).toMatchObject({
      id: row.id,
      userId: owner.userId,
      providerName: 'own-provider',
    });
  });

  it('sumProviderTransactions under the debt row lock matches the sum of the provider transactions already taken', async () => {
    const { userId, walletId } = await seededPlayer();
    const providerName = 'lock-provider';
    const externalRoundId = `round-${randomUUID()}`;
    const base = { providerName, externalRoundId, type: 'bet' as const };
    await seedTransaction(walletId, { ...base, amount: '2.5', providerRefId: 'bet:a-1' });
    await seedTransaction(walletId, { ...base, amount: '1.5', providerRefId: 'win:a-1' });
    await seedTransaction(walletId, { ...base, amount: '9', providerRefId: 'bet:other' });
    await seedTransaction(walletId, {
      ...base,
      amount: '7',
      providerRefId: 'failed:a-1',
      status: 'failed',
    });
    await seedTransaction(walletId, {
      ...base,
      type: 'win',
      amount: '5',
      providerRefId: 'win2:a-1',
    });
    const query = { providerName, externalRoundId, type: 'bet' as const, providerRefSuffix: 'a-1' };

    const [rawTaken] = await rawRows<{ total: string | null }>(
      sql`select coalesce(sum(amount), 0)::text as total from wallet_transaction
          where provider_name = ${providerName} and external_round_id = ${externalRoundId}
            and type = 'bet' and status = 'completed' and provider_ref_id like '%:a-1'`,
    );

    const underLock = await db().transaction(async (tx) => {
      await tx.select().from(wallet).where(eq(wallet.userId, userId)).for('update');
      return reader.sumProviderTransactions(query, tx);
    });

    expect(underLock).toBe(rawTaken?.total);
    expect(underLock).toBe('4.000000000000000000');
    expect(
      await reader.sumProviderTransactions({ ...query, providerRefSuffix: 'missing' }, db()),
    ).toBe('0');
  });

  it('hasWallet is false before the first wallet row and true after it', async () => {
    const userId = randomUUID();

    await db().transaction(async (tx) => {
      expect(await reader.hasWallet(userId, tx)).toBe(false);
      await seedWallet(userId, tx);
      expect(await reader.hasWallet(userId, tx)).toBe(true);
    });

    expect(await reader.hasWallet(userId, db())).toBe(true);
  });
});

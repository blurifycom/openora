import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { findOneOrThrow, moneyCompare, moneyScaleBy } from '@openora/core/server';
import { migrate as migrateOutbox } from '@openora/core/server/migrate';
import {
  WalletTurnoverConfigSchema,
  definePlatformConfig,
  type ExchangeRateReader,
  type PlayEligibilityPort,
} from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { makeAuditWriter, makeOutboxEventBus, mock } from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { wallet, walletBalance, walletTurnover, walletTurnoverEntry } from '../schema/index.js';
import { TurnoverService } from '../service/turnover.service.js';
import { WalletCommandsService } from '../service/wallet-commands.service.js';

let db: TestDb;
const rates = new Map<string, string>();
const getRate = vi.fn(async (from: string) => {
  const rate = rates.get(from);
  return rate === undefined ? null : { rate, asOf: new Date().toISOString() };
});
const reader = mock<ExchangeRateReader>({
  getRate,
  convert: vi.fn(async (amount: string, from: string) => {
    const rate = rates.get(from);
    return rate === undefined ? null : moneyScaleBy(amount, rate);
  }),
});

const eligibility = mock<PlayEligibilityPort>({
  isRestricted: vi.fn().mockResolvedValue(false),
  checkPlay: vi.fn().mockResolvedValue(null),
});

const turnoverService = (multiplier: string) =>
  new TurnoverService({
    drizzle: db.drizzle,
    events: makeOutboxEventBus(),
    audit: makeAuditWriter(),
    config: WalletTurnoverConfigSchema.parse({ multiplier }),
    pivotCurrency: 'USD',
    rates: reader,
  });

const commandsFor = (turnover: TurnoverService) =>
  new WalletCommandsService(eligibility, makeAuditWriter(), {
    platformConfig: definePlatformConfig({ wallet: { transferCredits: 'cash' } }),
    turnover: () => turnover,
  });

let commands: WalletCommandsService;

const expectMoney = (actual: string | null | undefined, expected: string, label: string) =>
  expect(moneyCompare(String(actual), expected) === 0, `${label}: ${String(actual)}`).toBe(true);

async function player(balance = '100') {
  const userId = randomUUID();
  const row = findOneOrThrow(
    await db.drizzle.db.insert(wallet).values({ userId, currency: 'USD' }).returning(),
    new Error('seed wallet: no row'),
  );
  await db.drizzle.db
    .insert(walletBalance)
    .values({ walletId: row.id, currency: 'USD', amount: balance });
  return userId;
}

const balanceOf = async (userId: string) =>
  findOneOrThrow(
    await db.drizzle.db
      .select({ amount: walletBalance.amount })
      .from(walletBalance)
      .innerJoin(wallet, eq(wallet.id, walletBalance.walletId))
      .where(eq(wallet.userId, userId)),
    new Error('balance missing'),
  ).amount;

const unrated = () => `Z${randomUUID().slice(0, 6).toUpperCase()}`;

const addPending = (turnover: TurnoverService, userId: string, currency: string, amount = '10') =>
  db.drizzle.db.transaction((tx) =>
    turnover.addCredit(tx, { userId, kind: 'deposit', sourceRef: randomUUID(), currency, amount }),
  );

const turnoverRow = async (userId: string) =>
  findOneOrThrow(
    await db.drizzle.db.select().from(walletTurnover).where(eq(walletTurnover.userId, userId)),
    new Error('no turnover row'),
  );

beforeAll(async () => {
  db = await createTestDb([migrateOutbox, migrate]);
  commands = commandsFor(turnoverService('1'));
});

afterAll(async () => {
  await db.drop();
});

describe('locking the wallets of a transfer', () => {
  const crossTransfer = (
    from: string,
    to: string,
    { lock, barrier }: { lock: boolean; barrier?: () => Promise<void> },
  ) =>
    db.drizzle.db.transaction(async (tx) => {
      if (lock) {
        await commands.lockWallets(tx, { userIds: [from, to] });
      }
      const providerRef = { providerName: 'gifts', providerRefId: randomUUID() };
      await commands.debit(tx, {
        userId: from,
        amount: '1',
        currency: 'USD',
        type: 'gift',
        providerRef,
      });
      await barrier?.();
      await commands.credit(tx, {
        userId: to,
        amount: '1',
        currency: 'USD',
        type: 'gift',
        providerRef,
      });
    });

  const rendezvous = () => {
    let arrived = 0;
    let release: () => void = () => undefined;
    const open = new Promise<void>((resolve) => {
      release = resolve;
    });
    return () => {
      arrived += 1;
      if (arrived === 2) {
        release();
      }
      return open;
    };
  };

  it('deadlocks two opposite transfers that skip it, the case it exists for', async () => {
    const a = await player();
    const b = await player();
    const barrier = rendezvous();

    const outcomes = await Promise.allSettled([
      crossTransfer(a, b, { lock: false, barrier }),
      crossTransfer(b, a, { lock: false, barrier }),
    ]);

    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
    );
    expect(rejected).toHaveLength(1);
    expect((rejected[0]?.reason as { cause?: { code?: string } }).cause?.code).toBe('40P01');
  });

  it('lets the same two transfers through when each takes both wallets first', async () => {
    const a = await player();
    const b = await player();
    const outcomes = await Promise.allSettled([
      crossTransfer(a, b, { lock: true }),
      crossTransfer(b, a, { lock: true }),
    ]);

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled']);
    expectMoney(await balanceOf(a), '100', 'a');
    expectMoney(await balanceOf(b), '100', 'b');
  });

  it('takes no lock for an empty list and tolerates repeated and unknown ids', async () => {
    const a = await player();
    const stranger = randomUUID();

    await db.drizzle.db.transaction(async (tx) => {
      await commands.lockWallets(tx, { userIds: [] });
      await commands.lockWallets(tx, { userIds: [a, a, a] });
      await commands.lockWallets(tx, { userIds: [stranger, stranger, a] });
    });

    expect(await db.drizzle.db.select().from(wallet).where(eq(wallet.userId, stranger))).toEqual(
      [],
    );
    expectMoney(await balanceOf(a), '100', 'balance');
  });

  it('keeps a self transfer whole', async () => {
    const a = await player();

    await db.drizzle.db.transaction(async (tx) => {
      await commands.lockWallets(tx, { userIds: [a, a] });
      const providerRef = { providerName: 'gifts', providerRefId: randomUUID() };
      await commands.debit(tx, {
        userId: a,
        amount: '5',
        currency: 'USD',
        type: 'gift',
        providerRef,
      });
      await commands.credit(tx, {
        userId: a,
        amount: '5',
        currency: 'USD',
        type: 'gift',
        providerRef,
      });
    });

    expectMoney(await balanceOf(a), '100', 'balance');
  });
});

describe('pricing a player pending entries before a withdrawal', () => {
  it('prices once when many withdrawals ask at the same time', async () => {
    const turnover = turnoverService('2');
    const userId = randomUUID();
    const currency = unrated();
    await addPending(turnover, userId, currency, '10');
    await addPending(turnover, userId, currency, '5');
    rates.set(currency, '3');

    await Promise.all(Array.from({ length: 6 }, () => turnover.pricePendingNow(userId)));

    const row = await turnoverRow(userId);
    expect(row.pendingCount).toBe(0);
    expectMoney(row.required, '90', 'required');
    const entries = await db.drizzle.db
      .select()
      .from(walletTurnoverEntry)
      .where(eq(walletTurnoverEntry.userId, userId));
    expect(entries.map((entry) => entry.status)).toEqual(['counted', 'counted']);
  });

  it('leaves an entry with no rate pending and refuses the withdrawal as pending', async () => {
    const turnover = turnoverService('1');
    const userId = randomUUID();
    await addPending(turnover, userId, unrated());

    await turnover.pricePendingNow(userId);

    expect(await turnoverRow(userId)).toMatchObject({ pendingCount: 1 });
    await expect(
      db.drizzle.db.transaction((tx) =>
        turnover.assertOutflow(tx, { userId, outflow: 'withdrawal' }),
      ),
    ).rejects.toMatchObject({ data: { pending: true } });
  });

  it('opens no transaction and looks up no rate at multiplier 0', async () => {
    const off = turnoverService('0');
    const userId = randomUUID();
    const transaction = vi.spyOn(db.drizzle.db, 'transaction');
    getRate.mockClear();

    await off.pricePendingNow(userId);

    expect(transaction).not.toHaveBeenCalled();
    expect(getRate).not.toHaveBeenCalled();
    transaction.mockRestore();
  });

  it('opens no transaction for a player with nothing pending', async () => {
    const turnover = turnoverService('1');
    const userId = randomUUID();
    await addPending(turnover, userId, 'USD');
    const transaction = vi.spyOn(db.drizzle.db, 'transaction');

    await turnover.pricePendingNow(userId);
    await turnover.pricePendingNow(randomUUID());

    expect(transaction).not.toHaveBeenCalled();
    transaction.mockRestore();
  });
});

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { findOneOrThrow, moneyAdd, moneyCompare, moneyScaleBy } from '@openora/core/server';
import { migrate as migrateOutbox } from '@openora/core/server/migrate';
import {
  TurnoverLockedError,
  WalletTurnoverConfigSchema,
  definePlatformConfig,
  type ExchangeRateReader,
  type PlayEligibilityPort,
  type WalletTransactionType,
} from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { makeAuditWriter, makeOutboxEventBus, mock } from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { wallet, walletBalance, walletTurnover, walletTurnoverEntry } from '../schema/index.js';
import { TurnoverService } from '../service/turnover.service.js';
import { WalletCommandsService } from '../service/wallet-commands.service.js';

let db: TestDb;
const rates = new Map<string, string>();
const reader: ExchangeRateReader = {
  getRate: async () => null,
  convert: vi.fn(async (amount: string, from: string) => {
    const rate = rates.get(from);
    return rate === undefined ? null : moneyScaleBy(amount, rate);
  }),
};

const eligibility = mock<PlayEligibilityPort>({
  isRestricted: vi.fn().mockResolvedValue(false),
  checkPlay: vi.fn().mockResolvedValue(null),
});

function services(multiplier: string) {
  const turnover = new TurnoverService({
    drizzle: db.drizzle,
    events: makeOutboxEventBus(),
    audit: makeAuditWriter(),
    config: WalletTurnoverConfigSchema.parse({ multiplier }),
    pivotCurrency: 'USD',
    rates: reader,
  });
  const commands = new WalletCommandsService(eligibility, makeAuditWriter(), {
    platformConfig: definePlatformConfig({ wallet: { turnover: { multiplier } } }),
    turnover: () => turnover,
  });
  return { turnover, commands };
}

let on: ReturnType<typeof services>;
let off: ReturnType<typeof services>;

const expectMoney = (actual: string | null | undefined, expected: string, label: string) =>
  expect(moneyCompare(String(actual), expected) === 0, `${label}: ${String(actual)}`).toBe(true);

async function player(balance = '500') {
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

const owe = (svc: TurnoverService, userId: string, amount: string, currency = 'USD') =>
  db.drizzle.db.transaction((tx) =>
    svc.addCredit(tx, { userId, kind: 'deposit', sourceRef: randomUUID(), currency, amount }),
  );

const balanceOf = async (userId: string) =>
  findOneOrThrow(
    await db.drizzle.db
      .select({ amount: walletBalance.amount })
      .from(walletBalance)
      .innerJoin(wallet, eq(wallet.id, walletBalance.walletId))
      .where(eq(wallet.userId, userId)),
    new Error('balance missing'),
  ).amount;

const debit = (
  commands: WalletCommandsService,
  userId: string,
  type: WalletTransactionType,
  providerRefId = randomUUID(),
) =>
  db.drizzle.db.transaction((tx) =>
    commands.debit(tx, {
      userId,
      amount: '10',
      currency: 'USD',
      type,
      providerRef: { providerName: 'gifts', providerRefId },
      ...(type === 'bet' ? { context: { provider: 'agg', product: 'casino' as const } } : {}),
    }),
  );

const movable = (commands: WalletCommandsService, userId: string) =>
  db.drizzle.db.transaction((tx) => commands.movableFunds(tx, { userId, currency: 'USD' }));

const assertOutflow = (userId: string, outflow: 'withdrawal' | 'transfer' = 'withdrawal') =>
  db.drizzle.db.transaction((tx) => on.turnover.assertOutflow(tx, { userId, outflow }));

beforeAll(async () => {
  db = await createTestDb([migrateOutbox, migrate]);
  on = services('1');
  off = services('0');
});

afterAll(async () => {
  await db.drop();
});

describe('the outflow gate', () => {
  it('passes a player with no requirement, and refuses one who owes more than dust', async () => {
    const userId = await player();
    await expect(assertOutflow(userId)).resolves.toBeUndefined();

    await owe(on.turnover, userId, '100');

    const refusal = await assertOutflow(userId, 'transfer').catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(TurnoverLockedError);
    expect(refusal).toMatchObject({
      data: { reason: 'turnover_requirement_unmet', outflow: 'transfer', pending: false },
    });
  });

  it('refuses as pending while an entry has no rate, then prices it on a withdrawal', async () => {
    const userId = await player();
    const currency = `X${randomUUID().slice(0, 6).toUpperCase()}`;
    await owe(on.turnover, userId, '10', currency);

    await expect(assertOutflow(userId)).rejects.toMatchObject({
      data: { pending: true, remaining: '0' },
    });
    // A transfer does not price; it stays refused as pending.
    rates.set(currency, '3');
    await expect(assertOutflow(userId, 'transfer')).rejects.toMatchObject({
      data: { pending: true },
    });
    const refusal = await assertOutflow(userId).catch((error: unknown) => error);
    expect(refusal).toMatchObject({ data: { pending: false } });
    expectMoney((refusal as TurnoverLockedError).data.remaining, '30', 'priced remaining');
  });

  it('does nothing while the multiplier is 0', async () => {
    const userId = await player();
    await owe(on.turnover, userId, '100');

    await expect(
      db.drizzle.db.transaction((tx) =>
        off.turnover.assertOutflow(tx, { userId, outflow: 'withdrawal' }),
      ),
    ).resolves.toBeUndefined();
  });
});

describe('a debit through the command port', () => {
  it.each(['gift', 'rain', 'donation', 'cashback'] as const)(
    'refuses a %s debit as a transfer and moves nothing',
    async (type) => {
      const userId = await player();
      await owe(on.turnover, userId, '100');

      await expect(debit(on.commands, userId, type)).rejects.toMatchObject({
        name: 'TurnoverLockedError',
        data: { outflow: 'transfer' },
      });
      expectMoney(await balanceOf(userId), '500', 'balance');
    },
  );

  it('refuses a withdrawal debit as a withdrawal', async () => {
    const userId = await player();
    await owe(on.turnover, userId, '100');

    await expect(debit(on.commands, userId, 'withdrawal')).rejects.toMatchObject({
      data: { outflow: 'withdrawal' },
    });
  });

  it('lets bets, losses, admin debits and swap out-legs through', async () => {
    const userId = await player();
    await owe(on.turnover, userId, '100');

    for (const type of ['bet', 'manual_debit', 'swap_out'] as const) {
      expect(await debit(on.commands, userId, type), type).toMatchObject({ ok: true });
    }
    expectMoney(await balanceOf(userId), '470', 'balance');
  });

  it('answers a replay of a gift committed before the requirement, not a refusal', async () => {
    const userId = await player();
    const ref = randomUUID();
    expect(await debit(on.commands, userId, 'gift', ref)).toMatchObject({ ok: true, moved: true });
    await owe(on.turnover, userId, '100');

    expect(await debit(on.commands, userId, 'gift', ref)).toMatchObject({ ok: true, moved: false });
  });

  it('lets every debit through while the multiplier is 0', async () => {
    const userId = await player();
    await owe(on.turnover, userId, '100');

    expect(await debit(off.commands, userId, 'gift')).toMatchObject({ ok: true });
    expect(await movable(off.commands, userId)).toMatchObject({ locked: '0' });
  });

  it('reports nothing movable while turnover is unmet, and the whole balance once it is met', async () => {
    const userId = await player();
    await owe(on.turnover, userId, '100');

    const locked = await movable(on.commands, userId);
    expectMoney(locked.locked, '500', 'locked');
    expectMoney(locked.free, '0', 'free');

    await db.drizzle.db
      .update(walletTurnover)
      .set({ progress: '100' })
      .where(eq(walletTurnover.userId, userId));
    const free = await movable(on.commands, userId);
    expectMoney(free.locked, '0', 'locked after');
    expectMoney(free.free, '500', 'free after');
  });
});

describe('a credit racing a staff clear', () => {
  it('ends with the clear covering the credit or a live new requirement, never in between', async () => {
    const adminId = randomUUID();
    for (let run = 0; run < 10; run += 1) {
      const userId = await player();
      await owe(on.turnover, userId, '10');

      await Promise.all([
        owe(on.turnover, userId, '20'),
        on.turnover.clear(adminId, { userId, reason: 'race' }),
      ]);

      const row = findOneOrThrow(
        await db.drizzle.db.select().from(walletTurnover).where(eq(walletTurnover.userId, userId)),
        new Error('turnover row missing'),
      );
      const entries = await db.drizzle.db
        .select()
        .from(walletTurnoverEntry)
        .where(eq(walletTurnoverEntry.userId, userId));
      expect(entries).toHaveLength(2);
      const live = entries.filter((entry) => entry.status === 'counted');
      const owed = live.reduce((sum, entry) => moneyAdd(sum, entry.required ?? '0'), '0');
      expectMoney(row.required, owed, 'required matches the live entries');
      expect(row.pendingCount).toBe(0);
      expect(['0', '20']).toContain(String(Number(owed)));
    }
  });

  it('lets a clear that waits on an uncommitted credit clear that credit too', async () => {
    const adminId = randomUUID();
    const userId = await player();
    await owe(on.turnover, userId, '10');
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let credited!: () => void;
    const inserted = new Promise<void>((resolve) => {
      credited = resolve;
    });

    const credit = db.drizzle.db.transaction(async (tx) => {
      await on.turnover.addCredit(tx, {
        userId,
        kind: 'deposit',
        sourceRef: randomUUID(),
        currency: 'USD',
        amount: '20',
      });
      credited();
      await held;
    });
    await inserted;
    const clearing = on.turnover.clear(adminId, { userId, reason: 'waits on the credit' });
    release();
    await credit;
    const { cleared } = await clearing;

    expect(cleared).toBe(true);
    const entries = await db.drizzle.db
      .select({ status: walletTurnoverEntry.status })
      .from(walletTurnoverEntry)
      .where(
        and(
          eq(walletTurnoverEntry.userId, userId),
          inArray(walletTurnoverEntry.status, ['counted', 'pending']),
        ),
      );
    expect(entries).toEqual([]);
  });
});

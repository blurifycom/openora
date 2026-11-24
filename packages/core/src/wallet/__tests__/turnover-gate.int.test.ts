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
const reader = mock<ExchangeRateReader>({
  getRate: vi.fn(async (from: string) => {
    const rate = rates.get(from);
    return rate === undefined ? null : { rate, asOf: new Date().toISOString() };
  }),
  convert: vi.fn(async (amount: string, from: string) => {
    const rate = rates.get(from);
    return rate === undefined ? null : moneyScaleBy(amount, rate);
  }),
});

const eligibility = mock<PlayEligibilityPort>({
  isRestricted: vi.fn().mockResolvedValue(false),
  checkPlay: vi.fn().mockResolvedValue(null),
});

function services(multiplier: string, transferCredits?: 'cash') {
  const audit = makeAuditWriter();
  const turnover = new TurnoverService({
    drizzle: db.drizzle,
    events: makeOutboxEventBus(),
    audit,
    config: WalletTurnoverConfigSchema.parse({ multiplier }),
    pivotCurrency: 'USD',
    rates: reader,
  });
  const commands = new WalletCommandsService(eligibility, makeAuditWriter(), {
    platformConfig: definePlatformConfig({
      wallet: { turnover: { multiplier }, ...(transferCredits ? { transferCredits } : {}) },
    }),
    turnover: () => turnover,
  });
  return { turnover, commands, audit };
}

let on: ReturnType<typeof services>;
let off: ReturnType<typeof services>;
let cash: ReturnType<typeof services>;

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
  cash = services('1', 'cash');
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

  it('refuses as pending while an entry has no rate, and only a pricing pass prices it', async () => {
    const userId = await player();
    const currency = `X${randomUUID().slice(0, 6).toUpperCase()}`;
    await owe(on.turnover, userId, '10', currency);

    await expect(assertOutflow(userId)).rejects.toMatchObject({
      data: { pending: true, remaining: '0' },
    });
    rates.set(currency, '3');
    await expect(assertOutflow(userId)).rejects.toMatchObject({ data: { pending: true } });

    await on.turnover.pricePendingNow(userId);

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
});

describe('a cash transfer between players', () => {
  const gift = (
    commands: WalletCommandsService,
    from: string,
    to: string,
    providerRefId = randomUUID(),
  ) =>
    db.drizzle.db.transaction(async (tx) => {
      await commands.lockWallets(tx, { userIds: [from, to] });
      const providerRef = { providerName: 'gifts', providerRefId };
      const sent = await commands.debit(tx, {
        userId: from,
        amount: '1',
        currency: 'USD',
        type: 'gift',
        providerRef,
      });
      const received = await commands.credit(tx, {
        userId: to,
        amount: '1',
        currency: 'USD',
        type: 'gift',
        providerRef,
      });
      return { sent, received };
    });

  it('runs opposite transfers side by side without a deadlock and keeps both balances whole', async () => {
    const a = await player('100');
    const b = await player('100');

    for (let run = 0; run < 20; run += 1) {
      const results = await Promise.all([
        gift(cash.commands, a, b),
        gift(cash.commands, b, a),
        gift(cash.commands, a, b),
      ]);
      for (const { sent, received } of results) {
        expect(sent).toMatchObject({ ok: true, moved: true });
        expect(received).toMatchObject({ ok: true, moved: true });
      }
    }

    expectMoney(await balanceOf(a), '80', 'sender balance');
    expectMoney(await balanceOf(b), '120', 'recipient balance');
  });

  it('skips a player with no wallet and creates none', async () => {
    const a = await player('100');
    const stranger = randomUUID();

    await db.drizzle.db.transaction((tx) =>
      cash.commands.lockWallets(tx, { userIds: [stranger, a] }),
    );

    expect(await db.drizzle.db.select().from(wallet).where(eq(wallet.userId, stranger))).toEqual(
      [],
    );
  });

  it('credits a recipient once per provider and reference', async () => {
    const userId = await player('0');
    const providerRefId = randomUUID();
    const credit = (providerName: string) =>
      db.drizzle.db.transaction((tx) =>
        cash.commands.credit(tx, {
          userId,
          amount: '5',
          currency: 'USD',
          type: 'rain',
          providerRef: { providerName, providerRefId },
        }),
      );

    expect(await credit('rain-a')).toMatchObject({ ok: true, moved: true });
    expect(await credit('rain-b')).toMatchObject({ ok: true, moved: true });
    expect(await credit('rain-a')).toMatchObject({ ok: true, moved: false });
    expectMoney(await balanceOf(userId), '10', 'balance');
  });
});

describe('a staff clear', () => {
  it('audits how many entries it cleared and the first hundred of their ids', async () => {
    const userId = await player();
    for (let n = 0; n < 101; n += 1) {
      await owe(on.turnover, userId, '1');
    }
    on.audit.recordInTransaction.mockClear();

    expect(await on.turnover.clear(randomUUID(), { userId, reason: 'goodwill' })).toMatchObject({
      cleared: true,
      summary: { locked: false },
    });

    const [, entry] = on.audit.recordInTransaction.mock.calls.at(-1) ?? [];
    expect(entry).toMatchObject({ action: 'wallet.turnover.cleared', after: { entryCount: 101 } });
    expect((entry as { after: { entryIds: string[] } }).after.entryIds).toHaveLength(100);
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

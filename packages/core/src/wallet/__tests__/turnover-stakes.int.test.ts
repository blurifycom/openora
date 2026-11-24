import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { findOneOrThrow, moneyAdd, moneyCompare, moneyScaleBy } from '@openora/core/server';
import { migrate as migrateOutbox } from '@openora/core/server/migrate';
import {
  WalletCommandAmountError,
  WalletReplayMismatchError,
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
const rates = new Map<string, string>([['EUR', '2']]);
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

function services(multiplier: string, countAtSettle?: WagerProduct[]) {
  const turnover = new TurnoverService({
    drizzle: db.drizzle,
    events: makeOutboxEventBus(),
    audit: makeAuditWriter(),
    config: WalletTurnoverConfigSchema.parse({ multiplier, countAtSettle }),
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

async function player(balances: Record<string, string> = { USD: '500' }) {
  const userId = randomUUID();
  const row = findOneOrThrow(
    await db.drizzle.db.insert(wallet).values({ userId, currency: 'USD' }).returning(),
    new Error('seed wallet: no row'),
  );
  await db.drizzle.db.insert(walletBalance).values(
    Object.entries(balances).map(([currency, amount]) => ({
      walletId: row.id,
      currency,
      amount,
    })),
  );
  return { userId, walletId: row.id };
}

const owe = (svc: TurnoverService, userId: string, amount: string) =>
  db.drizzle.db.transaction((tx) =>
    svc.addCredit(tx, {
      userId,
      kind: 'deposit',
      sourceRef: randomUUID(),
      currency: 'USD',
      amount,
    }),
  );

const progressOf = async (userId: string) => {
  const [row] = await db.drizzle.db
    .select()
    .from(walletTurnover)
    .where(eq(walletTurnover.userId, userId));
  return row?.progress ?? '0';
};

const rowOf = async (id: string) =>
  findOneOrThrow(
    await db.drizzle.db.select().from(walletTransaction).where(eq(walletTransaction.id, id)),
    new Error('ledger row missing'),
  );

async function bet(
  commands: WalletCommandsService,
  userId: string,
  amount: string,
  {
    product = 'casino',
    currency = 'USD',
    round = randomUUID(),
  }: { product?: WagerProduct | null; currency?: string; round?: string } = {},
) {
  const outcome = await db.drizzle.db.transaction((tx) =>
    commands.debit(tx, {
      userId,
      amount,
      currency,
      type: 'bet',
      providerRef: { providerName: 'agg', providerRefId: randomUUID(), externalRoundId: round },
      ...(product === null ? {} : { context: { provider: 'agg', product } }),
    }),
  );
  if (!outcome.ok || !outcome.moved) {
    throw new Error('bet did not move');
  }
  return { id: outcome.transactionId, round };
}

const reverse = (
  commands: WalletCommandsService,
  userId: string,
  placed: { id: string; round: string },
  amount: string,
) =>
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

const stakesOf = (userId: string, walletId: string) =>
  db.drizzle.db
    .select({
      id: walletTransaction.id,
      round: walletTransaction.externalRoundId,
      amount: walletTransaction.amount,
      state: walletTransaction.turnoverState,
      contribution: walletTransaction.turnoverContribution,
      afterClear: sql<boolean>`${walletTransaction.createdAt} > coalesce((select ${walletTurnover.clearedAt} from ${walletTurnover} where ${walletTurnover.userId} = ${userId}), '-infinity')`,
    })
    .from(walletTransaction)
    .where(and(eq(walletTransaction.walletId, walletId), eq(walletTransaction.type, 'bet')));

beforeAll(async () => {
  db = await createTestDb([migrateOutbox, migrate]);
  on = services('1');
  off = services('0');
});

afterAll(async () => {
  await db.drop();
});

describe('turnover stakes without the bonus module', () => {
  it('counts a casino bet and a sportsbook stake closed by closeRound', async () => {
    const { commands, turnover } = on;
    const { userId } = await player();
    await owe(turnover, userId, '100');

    const casino = await bet(commands, userId, '30');
    expectMoney(await progressOf(userId), '30', 'after casino');
    expect(await rowOf(casino.id)).toMatchObject({ turnoverState: 'counted' });
    expectMoney((await rowOf(casino.id)).turnoverContribution, '30', 'casino stamp');

    const sports = await bet(commands, userId, '40', { product: 'sportsbook' });
    expectMoney(await progressOf(userId), '30', 'sportsbook at placement');
    expect(await rowOf(sports.id)).toMatchObject({ turnoverState: 'deferred' });

    const closeRound = () =>
      db.drizzle.db.transaction((tx) =>
        commands.closeRound(tx, {
          userId,
          currency: 'USD',
          providerRef: { providerName: 'agg', externalRoundId: sports.round },
        }),
      );
    expect(await closeRound()).toEqual({ completed: [], newBalance: null });
    expectMoney(await progressOf(userId), '70', 'sportsbook at settle');
    await closeRound();
    expectMoney(await progressOf(userId), '70', 'second close');
    expect(await rowOf(sports.id)).toMatchObject({ turnoverState: 'counted' });
  });

  it('counts nothing for a bet with no product context or no pivot rate', async () => {
    const { commands, turnover } = on;
    const { userId } = await player({ USD: '500', XQZ: '500' });
    await owe(turnover, userId, '100');

    const noContext = await bet(commands, userId, '10', { product: null });
    const unrated = await bet(commands, userId, '10', { currency: 'XQZ' });

    expectMoney(await progressOf(userId), '0', 'progress');
    expect(await rowOf(noContext.id)).toMatchObject({
      turnoverContribution: null,
      turnoverState: null,
    });
    expect(await rowOf(unrated.id)).toMatchObject({
      turnoverContribution: null,
      turnoverState: null,
    });
  });

  it('counts a deferred stake at settle after countAtSettle no longer names its product', async () => {
    const { commands, turnover } = on;
    const { userId } = await player();
    await owe(turnover, userId, '100');
    const sports = await bet(commands, userId, '40', { product: 'sportsbook' });

    await db.drizzle.db.transaction((tx) =>
      services('1', []).commands.closeRound(tx, {
        userId,
        currency: 'USD',
        providerRef: { providerName: 'agg', externalRoundId: sports.round },
      }),
    );

    expectMoney(await progressOf(userId), '40', 'progress');
    expect(await rowOf(sports.id)).toMatchObject({ turnoverState: 'counted' });
  });

  it('settles a stake placed before a staff clear without counting it toward a later requirement', async () => {
    const { commands, turnover } = on;
    const { userId } = await player();
    await owe(turnover, userId, '100');
    const sports = await bet(commands, userId, '40', { product: 'sportsbook' });
    await turnover.clear(randomUUID(), { userId, reason: 'goodwill' });
    await owe(turnover, userId, '100');

    await db.drizzle.db.transaction((tx) =>
      commands.closeRound(tx, {
        userId,
        currency: 'USD',
        providerRef: { providerName: 'agg', externalRoundId: sports.round },
      }),
    );

    expect(await rowOf(sports.id)).toMatchObject({ turnoverState: 'counted' });
    expectMoney(await progressOf(userId), '0', 'progress');
  });

  it('takes back nothing from a later requirement when a stake from before a staff clear is reversed', async () => {
    const { commands, turnover } = on;
    const { userId } = await player();
    await owe(turnover, userId, '100');
    const early = await bet(commands, userId, '40');
    const sports = await bet(commands, userId, '20', { product: 'sportsbook' });
    expectMoney(await progressOf(userId), '40', 'before the clear');
    await turnover.clear(randomUUID(), { userId, reason: 'goodwill' });
    await owe(turnover, userId, '100');
    await bet(commands, userId, '30');
    await db.drizzle.db.transaction((tx) =>
      commands.closeRound(tx, {
        userId,
        currency: 'USD',
        providerRef: { providerName: 'agg', externalRoundId: sports.round },
      }),
    );

    expect(await reverse(commands, userId, early, '40')).toMatchObject({ ok: true, moved: true });
    expect(await reverse(commands, userId, sports, '20')).toMatchObject({ ok: true, moved: true });

    expectMoney(await progressOf(userId), '30', 'progress');
  });

  it('takes back a stake placed after a staff clear', async () => {
    const { commands, turnover } = on;
    const { userId } = await player();
    await owe(turnover, userId, '100');
    await bet(commands, userId, '40');
    await turnover.clear(randomUUID(), { userId, reason: 'goodwill' });
    await owe(turnover, userId, '100');
    const late = await bet(commands, userId, '30');
    const later = await bet(commands, userId, '15');

    await reverse(commands, userId, late, '10');
    expectMoney(await progressOf(userId), '35', 'after a partial reversal');
    await reverse(commands, userId, later, '15');
    expectMoney(await progressOf(userId), '20', 'after a whole reversal');
  });

  it('shares an unnamed reversal over the whole stake of a round that spans a staff clear', async () => {
    const { commands, turnover } = on;
    const { userId } = await player();
    await owe(turnover, userId, '100');
    const early = await bet(commands, userId, '40');
    await turnover.clear(randomUUID(), { userId, reason: 'goodwill' });
    await owe(turnover, userId, '100');
    await bet(commands, userId, '30', { round: early.round });
    expectMoney(await progressOf(userId), '30', 'before the reversal');

    const reversal = await db.drizzle.db.transaction((tx) =>
      commands.credit(tx, {
        userId,
        amount: '40',
        currency: 'USD',
        type: 'bet_reversal',
        providerRef: {
          providerName: 'agg',
          providerRefId: randomUUID(),
          externalRoundId: early.round,
        },
      }),
    );

    expect(reversal).toMatchObject({ ok: true, moved: true });
    expectMoney(await progressOf(userId), '12.857142857142857143', 'progress');
  });

  it('stamps a bet racing a staff clear so that the stamp matches what it added', async () => {
    const { commands, turnover } = on;
    for (let run = 0; run < 25; run += 1) {
      const { userId, walletId } = await player();
      await owe(turnover, userId, '100');

      await Promise.all([
        bet(commands, userId, '5'),
        bet(commands, userId, '7', { product: 'sportsbook' }),
        turnover.clear(randomUUID(), { userId, reason: 'goodwill' }),
        owe(turnover, userId, '100'),
        bet(commands, userId, '3'),
        bet(commands, userId, '11'),
      ]);
      for (const { round, state } of await stakesOf(userId, walletId)) {
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

      const stakes = await stakesOf(userId, walletId);
      const countedAfterClear = stakes
        .filter(({ state, afterClear }) => state === 'counted' && afterClear)
        .reduce((sum, { contribution }) => moneyAdd(sum, contribution ?? '0'), '0');
      expectMoney(await progressOf(userId), countedAfterClear, `run ${run} progress`);

      for (const stake of stakes.filter(({ afterClear }) => !afterClear)) {
        await reverse(commands, userId, { id: stake.id, round: stake.round ?? '' }, stake.amount);
      }
      expectMoney(
        await progressOf(userId),
        countedAfterClear,
        `run ${run} after reversing the stakes before the clear`,
      );

      for (const stake of stakes.filter(({ afterClear }) => afterClear)) {
        await reverse(commands, userId, { id: stake.id, round: stake.round ?? '' }, stake.amount);
      }
      expectMoney(await progressOf(userId), '0', `run ${run} after reversing every stake`);
    }
  });

  it('takes back only what counted when a stake that met the requirement is reversed', async () => {
    const { commands, turnover } = on;
    const { userId } = await player();
    await owe(turnover, userId, '100');
    const first = await bet(commands, userId, '150');
    await owe(turnover, userId, '100');
    await bet(commands, userId, '100');

    await reverse(commands, userId, first, '150');

    expect(await turnover.summary(userId)).toMatchObject({
      required: '200.000000000000000000',
      progress: '100.000000000000000000',
      remaining: '100.000000000000000000',
    });
  });

  it('stamps a stake larger than the remainder with the remainder', async () => {
    const { commands, turnover } = on;
    const { userId } = await player();
    await owe(turnover, userId, '100');
    await bet(commands, userId, '30');

    const placed = await bet(commands, userId, '100');

    expectMoney((await rowOf(placed.id)).turnoverContribution, '70', 'stamp');
    expectMoney(await progressOf(userId), '100', 'progress');
  });

  it('stamps the whole stake while an entry waits for a rate', async () => {
    const { commands, turnover } = on;
    const { userId } = await player();
    await owe(turnover, userId, '100');
    await db.drizzle.db.transaction((tx) =>
      turnover.addCredit(tx, {
        userId,
        kind: 'deposit',
        sourceRef: randomUUID(),
        currency: 'XQZ',
        amount: '10',
      }),
    );

    const placed = await bet(commands, userId, '150');

    expectMoney((await rowOf(placed.id)).turnoverContribution, '150', 'stamp');
    expectMoney(await progressOf(userId), '150', 'progress');
  });

  it('stamps a deferred stake in full and adds at most the remainder when it settles', async () => {
    const { commands, turnover } = on;
    const { userId } = await player();
    await owe(turnover, userId, '100');
    const sports = await bet(commands, userId, '150', { product: 'sportsbook' });
    expectMoney((await rowOf(sports.id)).turnoverContribution, '150', 'stamp');

    await db.drizzle.db.transaction((tx) =>
      commands.closeRound(tx, {
        userId,
        currency: 'USD',
        providerRef: { providerName: 'agg', externalRoundId: sports.round },
      }),
    );

    expectMoney(await progressOf(userId), '100', 'progress');
  });

  it('touches nothing with multiplier 0', async () => {
    const { userId } = await player();
    vi.mocked(reader.convert).mockClear();
    vi.mocked(reader.getRate).mockClear();

    const placed = await bet(off.commands, userId, '20', { currency: 'USD' });
    const sports = await bet(off.commands, userId, '20', { product: 'sportsbook' });
    await db.drizzle.db.transaction((tx) =>
      off.commands.closeRound(tx, {
        userId,
        currency: 'USD',
        providerRef: { providerName: 'agg', externalRoundId: sports.round },
      }),
    );

    expect(await rowOf(placed.id)).toMatchObject({ turnoverContribution: null });
    expect(await rowOf(sports.id)).toMatchObject({ turnoverContribution: null });
    expect(reader.convert).not.toHaveBeenCalled();
    expect(reader.getRate).not.toHaveBeenCalled();
    expect(
      await db.drizzle.db.select().from(walletTurnover).where(eq(walletTurnover.userId, userId)),
    ).toEqual([]);
  });
});

describe('turnover requirement entries', () => {
  const requirement = (userId: string, sourceRef: string, requiredInCurrency: string) =>
    db.drizzle.db.transaction((tx) =>
      on.turnover.addRequirement(tx, {
        userId,
        currency: 'USD',
        requiredInCurrency,
        source: 'grant_conversion',
        sourceRef,
      }),
    );

  it('refuses a requirement that is not above zero', async () => {
    const { userId } = await player();

    await expect(requirement(userId, randomUUID(), '0')).rejects.toBeInstanceOf(
      WalletCommandAmountError,
    );
    await expect(requirement(userId, randomUUID(), '-5')).rejects.toBeInstanceOf(
      WalletCommandAmountError,
    );
    expect(
      await db.drizzle.db.select().from(walletTurnover).where(eq(walletTurnover.userId, userId)),
    ).toEqual([]);
  });

  it('refuses a requirement replay naming another player, currency or amount', async () => {
    const { userId } = await player();
    const sourceRef = randomUUID();
    const first = await requirement(userId, sourceRef, '50');

    expect(await requirement(userId, sourceRef, '50.0')).toEqual({ ...first, replayed: true });
    await expect(requirement(randomUUID(), sourceRef, '50')).rejects.toBeInstanceOf(
      WalletReplayMismatchError,
    );
    await expect(requirement(userId, sourceRef, '60')).rejects.toBeInstanceOf(
      WalletReplayMismatchError,
    );
    await expect(
      db.drizzle.db.transaction((tx) =>
        on.turnover.addRequirement(tx, {
          userId,
          currency: 'EUR',
          requiredInCurrency: '50',
          source: 'grant_conversion',
          sourceRef,
        }),
      ),
    ).rejects.toBeInstanceOf(WalletReplayMismatchError);
    expectMoney((await on.turnover.summary(userId)).required, '50', 'required');
  });

  it('refuses a credit replay naming another player or amount', async () => {
    const { userId } = await player();
    const sourceRef = randomUUID();
    const credit = (owner: string, amount: string) =>
      db.drizzle.db.transaction((tx) =>
        on.turnover.addCredit(tx, {
          userId: owner,
          kind: 'deposit',
          sourceRef,
          currency: 'USD',
          amount,
        }),
      );
    await credit(userId, '40');

    await expect(credit(randomUUID(), '40')).rejects.toBeInstanceOf(WalletReplayMismatchError);
    await expect(credit(userId, '41')).rejects.toBeInstanceOf(WalletReplayMismatchError);
    expect(await credit(userId, '40')).toMatchObject({ replayed: true });
    expectMoney((await on.turnover.summary(userId)).required, '40', 'required');
  });
});

describe('staff turnover reads while the multiplier is 0', () => {
  it('shows the stored requirement and entries to staff and nothing to the player', async () => {
    const { userId } = await player();
    await owe(on.turnover, userId, '100');
    await bet(on.commands, userId, '30');

    expect(await off.turnover.adminSummary(userId)).toMatchObject({
      enabled: false,
      locked: false,
      required: '100.000000000000000000',
      progress: '30.000000000000000000',
      remaining: '70.000000000000000000',
    });
    const page = await off.turnover.adminEntries(userId, { limit: 10 });
    expect(page.items).toEqual([
      expect.objectContaining({ source: 'deposit', status: 'counted', clearedBy: null }),
    ]);
    expect(await off.turnover.summary(userId)).toMatchObject({ enabled: false, required: '0' });
    expect(await off.turnover.entries(userId, { limit: 10 })).toEqual({
      items: [],
      nextCursor: null,
    });
  });
});

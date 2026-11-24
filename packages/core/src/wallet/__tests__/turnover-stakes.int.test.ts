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

  it('touches nothing with multiplier 0', async () => {
    const { userId } = await player();
    vi.mocked(reader.convert).mockClear();

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
    expect(
      await db.drizzle.db.select().from(walletTurnover).where(eq(walletTurnover.userId, userId)),
    ).toEqual([]);
  });
});

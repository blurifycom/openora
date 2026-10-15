import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type {
  AdminPlayerSummary,
  AdminUserDirectory,
  ExchangeRateReader,
} from '@openora/core/contracts';
import { createTestDb, seedCompletedDeposit, type TestDb } from '@openora/core/testing';
import { wallet, walletTransaction } from '@openora/core/wallet/schema';
import {
  game,
  gameCategory,
  gameCategoryGame,
  gameProvider,
  gameRound,
} from '@openora/core/casino/schema/gaming';
import { user, session } from '@openora/core/pam/schema/identity';
import { player } from '@openora/core/pam/schema/profile';
import { migrate as migrateWallet } from '@openora/core/wallet/migrate';
import { migrate as migrateGaming } from '@openora/core/casino/migrate/gaming';
import { migrate as migrateIdentity } from '@openora/core/pam/migrate/identity';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { mock } from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { userLimit, rgFlag, rgExclusion } from '../schema/index.js';
import { RgMonitoringService, RgRateUnavailableError } from '../service/rg-monitoring.service.js';
import { RgLimitGate } from '../adapters/rg-limit-gate.js';

let db: TestDb;

function identityRates(): ExchangeRateReader {
  return mock<ExchangeRateReader>({
    getRate: vi.fn(async (from: string, to: string) =>
      from === to ? { rate: '1', asOf: new Date().toISOString() } : null,
    ),
    convert: vi.fn(async (amount: string, from: string, to: string) =>
      from === to ? amount : null,
    ),
  });
}

const makeService = (directory?: AdminUserDirectory, rates: ExchangeRateReader = identityRates()) =>
  new RgMonitoringService({ drizzle: db.drizzle, rates, ...(directory ? { directory } : {}) });

async function seedDepositLimit(
  userId: string,
  amount: string,
  period = 'daily' as const,
  currency = 'USD',
) {
  await db.drizzle.db
    .insert(userLimit)
    .values({ userId, type: 'deposit', amount, minutes: null, currency, period });
}

async function seedUnresolvedDepositLimit(
  userId: string,
  amount: string,
  period = 'daily' as const,
) {
  const [row] = await db.drizzle.db
    .insert(userLimit)
    .values({ userId, type: 'deposit', amount, minutes: null, currency: null, period })
    .returning();
  return row!;
}

async function seedPlayer(userId: string, currency: string) {
  await db.drizzle.db.insert(player).values({ userId, currency, kycStatus: 'verified' });
}

const seedDeposit = (userId: string, amount: string, backdatedTo?: Date) =>
  seedCompletedDeposit(db, userId, amount, backdatedTo ? { createdAt: backdatedTo } : {});

type Leg = Pick<typeof walletTransaction.$inferInsert, 'type' | 'amount' | 'direction'> &
  Partial<typeof walletTransaction.$inferInsert>;

async function seedLeg(userId: string, leg: Leg) {
  await db.drizzle.db.insert(wallet).values({ userId, currency: 'USD' }).onConflictDoNothing();
  const [row] = await db.drizzle.db.select().from(wallet).where(eq(wallet.userId, userId));
  await db.drizzle.db
    .insert(walletTransaction)
    .values({ walletId: row!.id, currency: 'USD', status: 'completed', ...leg });
}

async function seedCasinoRound(
  userId: string,
  betAmount: string,
  winAmount = '0',
  at = new Date(),
) {
  const [provider] = await db.drizzle.db
    .insert(gameProvider)
    .values({ slug: `studio-${randomUUID()}`, name: 'Mock Studio' })
    .returning();
  const [category] = await db.drizzle.db
    .insert(gameCategory)
    .values({ slug: `category-${randomUUID()}`, name: 'Slots' })
    .returning();
  const [g] = await db.drizzle.db
    .insert(game)
    .values({
      reviewStatus: 'approved',
      name: 'Slot',
      slug: `slot-${randomUUID()}`,
      providerId: provider!.id,
      aggregator: 'direct',
    })
    .returning();
  await db.drizzle.db.insert(gameCategoryGame).values({ gameId: g!.id, categoryId: category!.id });
  const [round] = await db.drizzle.db
    .insert(gameRound)
    .values({ gameId: g!.id, userId, betAmount, winAmount, currency: 'USD', startedAt: at })
    .returning();
  const ref = { providerName: 'internal', externalRoundId: round!.id, createdAt: at };
  await seedLeg(userId, {
    type: 'bet',
    amount: betAmount,
    direction: 'debit',
    providerRefId: `bet:${round!.id}`,
    ...ref,
  });
  if (Number(winAmount) > 0) {
    await seedLeg(userId, {
      type: 'win',
      amount: winAmount,
      direction: 'credit',
      providerRefId: `win:${round!.id}`,
      ...ref,
    });
  }
}

async function seedSession(userId: string, startedMinutesAgo: number) {
  const [u] = await db.drizzle.db
    .insert(user)
    .values({
      id: userId,
      name: 'P',
      username: `u_${userId.replaceAll('-', '').slice(0, 14)}`,
      email: `${userId}@test.dev`,
      emailVerified: true,
    })
    .returning();
  await db.drizzle.db.insert(session).values({
    userId: u!.id,
    token: randomUUID(),
    expiresAt: new Date(Date.now() + 3600_000),
    createdAt: new Date(Date.now() - startedMinutesAgo * 60_000),
  });
}

const SESSION_DETAIL = { sessionMinutes: 55, limitMinutes: 60, pct: 92 };

async function flagsOf(userId: string) {
  return db.drizzle.db.select().from(rgFlag).where(eq(rgFlag.userId, userId));
}

beforeAll(async () => {
  db = await createTestDb([migrate, migrateWallet, migrateGaming, migrateIdentity, migrateProfile]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${rgFlag}, ${rgExclusion}, ${userLimit}, ${walletTransaction}, ${wallet}, ${gameRound}, ${gameCategoryGame}, ${game}, ${gameProvider}, ${gameCategory}, ${session}, ${user}, ${player} RESTART IDENTITY CASCADE`,
  );
});

describe('RgMonitoringService.evaluateUser - deposit limits (real PG)', () => {
  it('raises a limit_threshold flag at exactly 80% of the limit', async () => {
    const userId = randomUUID();
    await seedDepositLimit(userId, '100');
    await seedDeposit(userId, '80');

    await makeService().evaluateUser(userId, 'wallet.deposit.completed');

    const flags = await flagsOf(userId);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({
      flagType: 'limit_threshold',
      limitType: 'deposit',
      status: 'active',
    });
    expect(flags[0]?.detail).toMatchObject({ pct: 80, period: 'daily' });
  });

  it('stays quiet just below the threshold', async () => {
    const userId = randomUUID();
    await seedDepositLimit(userId, '100');
    await seedDeposit(userId, '79');

    await makeService().evaluateUser(userId, 'wallet.deposit.completed');

    expect(await flagsOf(userId)).toHaveLength(0);
  });

  it('clears an existing flag once spend drops back below the threshold', async () => {
    const userId = randomUUID();
    await seedDepositLimit(userId, '100');
    await seedDeposit(userId, '80');
    await makeService().evaluateUser(userId, 'wallet.deposit.completed');
    await db.drizzle.db.delete(walletTransaction);

    await makeService().evaluateUser(userId, 'wallet.deposit.completed');

    const [flag] = await flagsOf(userId);
    expect(flag).toMatchObject({ status: 'cleared' });
    expect(flag?.clearedAt).toBeInstanceOf(Date);
  });

  it('updates the existing flag detail instead of raising a duplicate', async () => {
    const userId = randomUUID();
    await seedDepositLimit(userId, '100');
    await seedDeposit(userId, '80');
    await makeService().evaluateUser(userId, 'wallet.deposit.completed');
    await seedDeposit(userId, '20');

    await makeService().evaluateUser(userId, 'wallet.deposit.completed');

    const flags = await flagsOf(userId);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.detail).toMatchObject({ pct: 100 });
  });

  it('ignores deposits made outside the limit period window', async () => {
    const userId = randomUUID();
    await seedDepositLimit(userId, '100');
    await seedDeposit(userId, '90', new Date(Date.now() - 48 * 3600_000));

    await makeService().evaluateUser(userId, 'wallet.deposit.completed');

    expect(await flagsOf(userId)).toHaveLength(0);
  });

  it('skips the session limit on a deposit trigger', async () => {
    const userId = randomUUID();
    await db.drizzle.db.insert(userLimit).values({
      userId,
      type: 'session',
      amount: null,
      minutes: 60,
      currency: 'SESSION',
      period: 'session',
    });

    await makeService().evaluateUser(userId, 'wallet.deposit.completed');

    expect(await flagsOf(userId)).toHaveLength(0);
  });
});

describe('RgMonitoringService.evaluateUser - wager limits (real PG)', () => {
  it('sums stakes for a wager limit', async () => {
    const userId = randomUUID();
    await db.drizzle.db.insert(userLimit).values({
      userId,
      type: 'wager',
      amount: '100',
      minutes: null,
      currency: 'USD',
      period: 'daily',
    });
    await seedCasinoRound(userId, '90');

    await makeService().evaluateUser(userId, 'gaming.round.ended');

    const [flag] = await flagsOf(userId);
    expect(flag).toMatchObject({ flagType: 'limit_threshold', limitType: 'wager' });
  });
});

describe('RgMonitoringService.evaluateUser - loss limits (real PG)', () => {
  async function seedLossLimit(userId: string, amount: string) {
    await db.drizzle.db
      .insert(userLimit)
      .values({ userId, type: 'loss', amount, minutes: null, currency: 'USD', period: 'daily' });
  }

  it('counts NET loss - stakes minus winnings - not gross stakes', async () => {
    const userId = randomUUID();
    await seedLossLimit(userId, '100');
    await seedCasinoRound(userId, '1000', '900');

    await makeService().evaluateUser(userId, 'gaming.round.ended');

    const [flag] = await flagsOf(userId);
    expect(flag?.detail).toMatchObject({
      actual: '100.000000000000000000',
      limit: '100.000000000000000000',
      pct: 100,
    });
  });

  it('does not flag a player who is up on the window', async () => {
    const userId = randomUUID();
    await seedLossLimit(userId, '100');
    await seedCasinoRound(userId, '100', '400');

    await makeService().evaluateUser(userId, 'gaming.round.ended');

    expect(await flagsOf(userId)).toHaveLength(0);
  });

  it('flags a net loss that reaches the 80% band', async () => {
    const userId = randomUUID();
    await seedLossLimit(userId, '100');
    await seedCasinoRound(userId, '200', '120');

    await makeService().evaluateUser(userId, 'gaming.round.ended');

    const [flag] = await flagsOf(userId);
    expect(flag).toMatchObject({ flagType: 'limit_threshold', limitType: 'loss' });
  });
});

describe('RgMonitoringService.spendFor - play from the wallet ledger (real PG)', () => {
  const HOUR = 60 * 60 * 1000;
  const windowStart = () => new Date(Date.now() - HOUR);
  const before = () => new Date(Date.now() - 2 * HOUR);
  const spend = (
    userId: string,
    type: 'wager' | 'loss',
    rates: ExchangeRateReader = identityRates(),
  ) =>
    makeService(undefined, rates).spendFor(
      db.drizzle.db,
      userId,
      type,
      'daily',
      windowStart(),
      'USD',
    );

  async function sportsbookLeg(
    userId: string,
    ticket: string,
    leg: Pick<Leg, 'type' | 'amount' | 'direction'> & {
      at?: Date;
      currency?: string;
      correction?: boolean;
    },
  ) {
    await seedLeg(userId, {
      type: leg.type,
      amount: leg.amount,
      direction: leg.direction,
      correction: leg.correction ?? false,
      currency: leg.currency ?? 'USD',
      providerName: 'sportsbook',
      providerRefId: `${leg.type}:${ticket}:${randomUUID()}`,
      externalRoundId: ticket,
      createdAt: leg.at ?? new Date(),
    });
  }

  it('reads the same wager and loss as the casino rounds for plain rounds', async () => {
    const userId = randomUUID();
    await seedCasinoRound(userId, '100', '30');
    await seedCasinoRound(userId, '50', '0');
    await seedCasinoRound(userId, '20', '45');
    await seedCasinoRound(userId, '500', '0', before());
    await seedCasinoRound(userId, '10', '400', before());
    const legacy = await db.drizzle.db.execute<{ wager: string; loss: string }>(sql`
      select coalesce(sum(${gameRound.betAmount}), 0) as wager,
        greatest(coalesce(sum(${gameRound.betAmount} - ${gameRound.winAmount}), 0), 0) as loss
      from ${gameRound}
      where ${gameRound.userId} = ${userId} and ${gameRound.startedAt} >= ${windowStart()}
    `);

    expect(Number(await spend(userId, 'wager'))).toBe(Number(legacy.rows[0]!.wager));
    expect(Number(await spend(userId, 'loss'))).toBe(Number(legacy.rows[0]!.loss));
    expect(await spend(userId, 'wager')).toBe('170.000000000000000000');
    expect(await spend(userId, 'loss')).toBe('95.000000000000000000');
  });

  it('counts a stake on any product, not only casino rounds', async () => {
    const userId = randomUUID();
    await sportsbookLeg(userId, 't1', { type: 'bet', amount: '40', direction: 'debit' });

    expect(await spend(userId, 'wager')).toBe('40.000000000000000000');
    expect(await spend(userId, 'loss')).toBe('40.000000000000000000');
  });

  it('nets a voided stake out of the window its bet was placed in, and only that one', async () => {
    const userId = randomUUID();
    await sportsbookLeg(userId, 'in', { type: 'bet', amount: '40', direction: 'debit' });
    await sportsbookLeg(userId, 'in', { type: 'bet_reversal', amount: '40', direction: 'credit' });
    await sportsbookLeg(userId, 'old', {
      type: 'bet',
      amount: '70',
      direction: 'debit',
      at: before(),
    });
    await sportsbookLeg(userId, 'old', { type: 'bet_reversal', amount: '70', direction: 'credit' });
    await sportsbookLeg(userId, 'open', { type: 'bet', amount: '25', direction: 'debit' });

    expect(await spend(userId, 'wager')).toBe('25.000000000000000000');
  });

  it('adds a win taken back to the loss, and ignores a win on a bet placed before the window', async () => {
    const userId = randomUUID();
    await sportsbookLeg(userId, 'won', { type: 'bet', amount: '10', direction: 'debit' });
    await sportsbookLeg(userId, 'won', { type: 'win', amount: '30', direction: 'credit' });
    await sportsbookLeg(userId, 'won', { type: 'win_reversal', amount: '30', direction: 'debit' });
    await sportsbookLeg(userId, 'old', {
      type: 'bet',
      amount: '5',
      direction: 'debit',
      at: before(),
    });
    await sportsbookLeg(userId, 'old', { type: 'win', amount: '500', direction: 'credit' });

    expect(await spend(userId, 'loss')).toBe('10.000000000000000000');
  });

  it('counts only the in-window stake of a round that started before the window', async () => {
    const userId = randomUUID();
    await sportsbookLeg(userId, 'r', {
      type: 'bet',
      amount: '10',
      direction: 'debit',
      at: before(),
    });
    await sportsbookLeg(userId, 'r', { type: 'bet', amount: '10', direction: 'debit' });
    await sportsbookLeg(userId, 'r', { type: 'bet_reversal', amount: '10', direction: 'credit' });
    await sportsbookLeg(userId, 'r', { type: 'win', amount: '50', direction: 'credit' });

    expect(await spend(userId, 'wager')).toBe('10.000000000000000000');
    expect(await spend(userId, 'loss')).toBe('10.000000000000000000');
  });

  it('does not let a reopened bet bring back the void of a stake placed before the window', async () => {
    const userId = randomUUID();
    await sportsbookLeg(userId, 't', {
      type: 'bet',
      amount: '100',
      direction: 'debit',
      at: before(),
    });
    await sportsbookLeg(userId, 't', { type: 'bet_reversal', amount: '100', direction: 'credit' });
    await sportsbookLeg(userId, 'other', { type: 'bet', amount: '99', direction: 'debit' });
    await sportsbookLeg(userId, 't', {
      type: 'bet',
      amount: '0.01',
      direction: 'debit',
      correction: true,
    });

    expect(await spend(userId, 'wager')).toBe('99.010000000000000000');
  });

  it("never lets one round's reversal offset another round's stake", async () => {
    const userId = randomUUID();
    await sportsbookLeg(userId, 'x', { type: 'bet', amount: '10', direction: 'debit' });
    await sportsbookLeg(userId, 'x', { type: 'bet_reversal', amount: '30', direction: 'credit' });
    await sportsbookLeg(userId, 'y', { type: 'bet', amount: '20', direction: 'debit' });

    expect(await spend(userId, 'wager')).toBe('20.000000000000000000');
  });

  it('ignores a leg whose direction does not match its type', async () => {
    const userId = randomUUID();
    await sportsbookLeg(userId, 't', { type: 'bet', amount: '40', direction: 'debit' });
    await sportsbookLeg(userId, 't', { type: 'bet', amount: '15', direction: 'credit' });
    await sportsbookLeg(userId, 't', { type: 'win', amount: '25', direction: 'debit' });

    expect(await spend(userId, 'wager')).toBe('40.000000000000000000');
    expect(await spend(userId, 'loss')).toBe('40.000000000000000000');
  });

  it('never lets a reversal or a win without a round id offset a stake', async () => {
    const userId = randomUUID();
    await sportsbookLeg(userId, 't1', { type: 'bet', amount: '60', direction: 'debit' });
    await seedLeg(userId, { type: 'bet_reversal', amount: '60', direction: 'credit' });
    await seedLeg(userId, { type: 'win', amount: '60', direction: 'credit' });

    expect(await spend(userId, 'wager')).toBe('60.000000000000000000');
    expect(await spend(userId, 'loss')).toBe('60.000000000000000000');
  });

  it('skips a ledger row that did not complete', async () => {
    const userId = randomUUID();
    await sportsbookLeg(userId, 't1', { type: 'bet', amount: '60', direction: 'debit' });
    await seedLeg(userId, {
      type: 'bet',
      amount: '900',
      direction: 'debit',
      status: 'failed',
      providerName: 'sportsbook',
      externalRoundId: 't2',
    });

    expect(await spend(userId, 'wager')).toBe('60.000000000000000000');
  });

  it('floors each currency at zero before converting, so a win in one does not offset a loss in another', async () => {
    const userId = randomUUID();
    const btc = mock<ExchangeRateReader>({
      getRate: vi.fn(async () => null),
      convert: vi.fn(async (amount: string, from: string, to: string) =>
        from === 'BTC' && to === 'USD' ? (Number(amount) * 1000).toFixed(18) : null,
      ),
    });
    await sportsbookLeg(userId, 'usd', { type: 'bet', amount: '10', direction: 'debit' });
    await sportsbookLeg(userId, 'usd', { type: 'win', amount: '60', direction: 'credit' });
    await sportsbookLeg(userId, 'btc', {
      type: 'bet',
      amount: '0.1',
      direction: 'debit',
      currency: 'BTC',
    });

    expect(Number(await spend(userId, 'loss', btc))).toBe(100);
  });
});

describe('RgLimitGate loss handling (real PG)', () => {
  it('never refuses a wager on a loss limit', async () => {
    const userId = randomUUID();
    await db.drizzle.db.insert(userLimit).values({
      userId,
      type: 'loss',
      amount: '100',
      minutes: null,
      currency: 'USD',
      period: 'daily',
    });
    await seedCasinoRound(userId, '500');
    const gate = new RgLimitGate(makeService(), identityRates());

    await expect(gate.checkWager(db.drizzle.db, userId, '400', 'USD')).resolves.toEqual({
      allowed: true,
    });
  });

  it('still refuses a wager on a wager limit', async () => {
    const userId = randomUUID();
    await db.drizzle.db.insert(userLimit).values({
      userId,
      type: 'wager',
      amount: '100',
      minutes: null,
      currency: 'USD',
      period: 'daily',
    });
    await seedCasinoRound(userId, '90');
    const gate = new RgLimitGate(makeService(), identityRates());

    await expect(gate.checkWager(db.drizzle.db, userId, '20', 'USD')).resolves.toMatchObject({
      allowed: false,
      limitType: 'wager',
    });
  });

  it('counts the attempted amount, so a move that exactly fills the limit passes', async () => {
    const userId = randomUUID();
    await db.drizzle.db.insert(userLimit).values({
      userId,
      type: 'wager',
      amount: '100',
      minutes: null,
      currency: 'USD',
      period: 'daily',
    });
    await seedCasinoRound(userId, '90');
    const gate = new RgLimitGate(makeService(), identityRates());

    await expect(gate.checkWager(db.drizzle.db, userId, '10', 'USD')).resolves.toEqual({
      allowed: true,
    });
  });
});

describe('RgLimitGate multi-currency enforcement (real PG)', () => {
  const btcToUsd = (rate: number) =>
    mock<ExchangeRateReader>({
      getRate: vi.fn(async () => null),
      convert: vi.fn(async (amount: string, from: string, to: string) => {
        if (from === to) {
          return amount;
        }
        if (from === 'BTC' && to === 'USD') {
          return (Number(amount) * rate).toFixed(18);
        }
        return null;
      }),
    });

  it('refuses a BTC deposit that converts well past a USD deposit limit', async () => {
    const userId = randomUUID();
    await seedDepositLimit(userId, '100');
    const rates = btcToUsd(50000);
    const gate = new RgLimitGate(makeService(undefined, rates), rates);

    const decision = await gate.checkDeposit(db.drizzle.db, userId, '100', 'BTC');

    expect(decision).toMatchObject({ allowed: false, limitType: 'deposit' });
  });

  it('allows a BTC deposit that converts to comfortably under a USD deposit limit', async () => {
    const userId = randomUUID();
    await seedDepositLimit(userId, '100');
    const rates = btcToUsd(50000);
    const gate = new RgLimitGate(makeService(undefined, rates), rates);

    const decision = await gate.checkDeposit(db.drizzle.db, userId, '0.001', 'BTC');

    expect(decision).toEqual({ allowed: true });
  });

  it('refuses (fails closed) when no rate is available to convert the attempted amount', async () => {
    const userId = randomUUID();
    await seedDepositLimit(userId, '100');
    const noRates = mock<ExchangeRateReader>({
      getRate: vi.fn(async () => null),
      convert: vi.fn(async () => null),
    });
    const gate = new RgLimitGate(makeService(undefined, noRates), noRates);

    const decision = await gate.checkDeposit(db.drizzle.db, userId, '0.001', 'BTC');

    expect(decision).toMatchObject({ allowed: false, limitType: 'deposit' });
  });

  it('refuses (fails closed) when no rate is available to convert prior spend in another currency', async () => {
    const userId = randomUUID();
    await seedDepositLimit(userId, '100');
    await seedCompletedDeposit(db, userId, '0.001', { currency: 'BTC' });
    const noRates = mock<ExchangeRateReader>({
      getRate: vi.fn(async () => null),
      convert: vi.fn(async () => null),
    });
    const gate = new RgLimitGate(makeService(undefined, noRates), noRates);

    const decision = await gate.checkDeposit(db.drizzle.db, userId, '1', 'USD');

    expect(decision).toMatchObject({ allowed: false, limitType: 'deposit' });
  });

  it("counts a held deposit released today in today's window even though it landed days ago", async () => {
    const userId = randomUUID();
    await seedDepositLimit(userId, '100');
    await seedCompletedDeposit(db, userId, '50', {
      createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
      reviewedAt: new Date(),
    });
    const gate = new RgLimitGate(makeService(), identityRates());

    const decision = await gate.checkDeposit(db.drizzle.db, userId, '60', 'USD');

    expect(decision).toMatchObject({ allowed: false, limitType: 'deposit' });
  });

  it('spendFor itself throws RgRateUnavailableError rather than silently treating a foreign-currency group as zero', async () => {
    const userId = randomUUID();
    await seedCompletedDeposit(db, userId, '0.001', { currency: 'BTC' });
    const noRates = mock<ExchangeRateReader>({
      getRate: vi.fn(async () => null),
      convert: vi.fn(async () => null),
    });

    await expect(
      makeService(undefined, noRates).spendFor(
        db.drizzle.db,
        userId,
        'deposit',
        'daily',
        new Date(0),
        'USD',
      ),
    ).rejects.toBeInstanceOf(RgRateUnavailableError);
  });
});

describe('RgMonitoringService.evaluateUser - deposits past the limit (real PG)', () => {
  it('flags a deposit total that has already passed the limit', async () => {
    const userId = randomUUID();
    await seedDepositLimit(userId, '100');
    await seedDeposit(userId, '150');

    await makeService().evaluateUser(userId, 'wallet.deposit.completed');

    const [flag] = await flagsOf(userId);
    expect(flag).toMatchObject({ flagType: 'limit_threshold', limitType: 'deposit' });
    expect(flag?.detail).toMatchObject({ limit: '100.000000000000000000', pct: 150 });
  });
});

describe('RgMonitoringService.evaluateUser - blocked login (real PG)', () => {
  it('labels the flag with self_exclusion when one is active', async () => {
    const userId = randomUUID();
    await db.drizzle.db.insert(rgExclusion).values({
      userId,
      kind: 'self_exclusion',
      status: 'active',
      reason: 'stop',
      isPermanent: true,
      createdBy: randomUUID(),
    });

    await makeService().evaluateUser(userId, 'rg.exclusion.login_blocked');

    const [flag] = await flagsOf(userId);
    expect(flag).toMatchObject({ flagType: 'self_excluded_login', limitType: null });
    expect(flag?.detail).toMatchObject({ kind: 'self_exclusion' });
  });

  it('labels the flag with cooling_off when that is the only active exclusion', async () => {
    const userId = randomUUID();
    await db.drizzle.db.insert(rgExclusion).values({
      userId,
      kind: 'cooling_off',
      status: 'active',
      reason: 'break',
      expiresAt: new Date(Date.now() + 3600_000),
      createdBy: randomUUID(),
    });

    await makeService().evaluateUser(userId, 'rg.exclusion.login_blocked');

    const [flag] = await flagsOf(userId);
    expect(flag?.detail).toMatchObject({ kind: 'cooling_off' });
  });

  it('records a null kind when nothing is active any more', async () => {
    const userId = randomUUID();

    await makeService().evaluateUser(userId, 'rg.exclusion.login_blocked');

    const [flag] = await flagsOf(userId);
    expect(flag?.detail).toMatchObject({ kind: null });
  });
});

describe('RgMonitoringService.sweep (real PG)', () => {
  it('raises a session_time flag once the active session reaches the limit band', async () => {
    const userId = randomUUID();
    await db.drizzle.db.insert(userLimit).values({
      userId,
      type: 'session',
      amount: null,
      minutes: 60,
      currency: 'SESSION',
      period: 'session',
    });
    await seedSession(userId, 50);

    await makeService().sweep();

    const [flag] = await flagsOf(userId);
    expect(flag).toMatchObject({ flagType: 'session_time', status: 'active' });
  });

  it('leaves a short session unflagged', async () => {
    const userId = randomUUID();
    await db.drizzle.db.insert(userLimit).values({
      userId,
      type: 'session',
      amount: null,
      minutes: 60,
      currency: 'SESSION',
      period: 'session',
    });
    await seedSession(userId, 10);

    await makeService().sweep();

    expect(await flagsOf(userId)).toHaveLength(0);
  });

  it('clears the flag once the session is gone', async () => {
    const userId = randomUUID();
    await db.drizzle.db.insert(userLimit).values({
      userId,
      type: 'session',
      amount: null,
      minutes: 60,
      currency: 'SESSION',
      period: 'session',
    });
    await seedSession(userId, 50);
    await makeService().sweep();
    await db.drizzle.db.delete(session).where(eq(session.userId, userId));

    await makeService().sweep();

    const [flag] = await flagsOf(userId);
    expect(flag).toMatchObject({ status: 'cleared' });
  });
});

describe('RgMonitoringService.listFlags (real PG)', () => {
  it('filters by flag type and reports the unpaginated total', async () => {
    const userId = randomUUID();
    await db.drizzle.db.insert(rgFlag).values([
      {
        userId,
        flagType: 'limit_threshold' as const,
        limitType: 'deposit',
        detail: SESSION_DETAIL,
      },
      { userId, flagType: 'session_time' as const, limitType: null, detail: SESSION_DETAIL },
    ]);

    const result = await makeService().listFlags({
      page: 1,
      limit: 10,
      flagType: 'limit_threshold',
    });

    expect(result.total).toBe(1);
    expect(result.items[0]).toMatchObject({ flagType: 'limit_threshold', limitType: 'deposit' });
  });

  it('enriches rows with the player directory when one is bound', async () => {
    const userId = randomUUID();
    await db.drizzle.db
      .insert(rgFlag)
      .values({ userId, flagType: 'session_time', limitType: null, detail: SESSION_DETAIL });
    const directory = mock<AdminUserDirectory>({
      lookupPlayers: vi.fn(async (ids: string[]) =>
        ids.map((id) =>
          mock<AdminPlayerSummary>({ userId: id, username: 'player1', email: 'p@test.dev' }),
        ),
      ),
    });

    const result = await makeService(directory).listFlags({ page: 1, limit: 10 });

    expect(result.items[0]).toMatchObject({ username: 'player1', email: 'p@test.dev' });
  });

  it('leaves the identity fields null when no directory is bound', async () => {
    const userId = randomUUID();
    await db.drizzle.db
      .insert(rgFlag)
      .values({ userId, flagType: 'session_time', limitType: null, detail: SESSION_DETAIL });

    const result = await makeService().listFlags({ page: 1, limit: 10 });

    expect(result.items[0]).toMatchObject({ username: null, email: null });
  });

  it('pages the rows while the total covers the whole filtered set', async () => {
    const userId = randomUUID();
    await db.drizzle.db.insert(rgFlag).values([
      { userId, flagType: 'session_time' as const, limitType: null, detail: SESSION_DETAIL },
      { userId, flagType: 'self_excluded_login' as const, limitType: null, detail: SESSION_DETAIL },
      { userId, flagType: 'limit_threshold' as const, limitType: 'loss', detail: SESSION_DETAIL },
    ]);

    const result = await makeService().listFlags({ page: 2, limit: 2 });

    expect(result.total).toBe(3);
    expect(result.items).toHaveLength(1);
  });
});

describe('RgLimitGate lazy currency resolution (real PG)', () => {
  it('resolves a null-currency limit to the player currency on first check, and persists it', async () => {
    const userId = randomUUID();
    await seedPlayer(userId, 'JPY');
    const seeded = await seedUnresolvedDepositLimit(userId, '100000');
    expect(seeded.currency).toBeNull();
    const gate = new RgLimitGate(makeService(), identityRates());

    await expect(gate.checkDeposit(db.drizzle.db, userId, '1000', 'JPY')).resolves.toEqual({
      allowed: true,
    });

    const [row] = await db.drizzle.db.select().from(userLimit).where(eq(userLimit.userId, userId));
    expect(row?.currency).toBe('JPY');
  });

  it('fails the deposit closed (refuses, does not default to USD) when no player record exists', async () => {
    const userId = randomUUID();
    await seedUnresolvedDepositLimit(userId, '100000');
    const gate = new RgLimitGate(makeService(), identityRates());

    const decision = await gate.checkDeposit(db.drizzle.db, userId, '1', 'USD');

    expect(decision).toMatchObject({ allowed: false, limitType: 'deposit' });
    const [row] = await db.drizzle.db.select().from(userLimit).where(eq(userLimit.userId, userId));
    expect(row?.currency).toBeNull();
  });

  it('resolves two concurrent checks of the same unresolved limit to the same currency', async () => {
    const userId = randomUUID();
    await seedPlayer(userId, 'GBP');
    await seedUnresolvedDepositLimit(userId, '100000');
    const gate = new RgLimitGate(makeService(), identityRates());

    const [a, b] = await Promise.all([
      gate.checkDeposit(db.drizzle.db, userId, '10', 'GBP'),
      gate.checkDeposit(db.drizzle.db, userId, '10', 'GBP'),
    ]);

    expect(a).toEqual({ allowed: true });
    expect(b).toEqual({ allowed: true });
    const [row] = await db.drizzle.db.select().from(userLimit).where(eq(userLimit.userId, userId));
    expect(row?.currency).toBe('GBP');
  });
});

describe('RgMonitoringService.evaluateUser lazy currency resolution (real PG)', () => {
  it('resolves a null-currency limit before comparing spend, and persists it', async () => {
    const userId = randomUUID();
    await seedPlayer(userId, 'EUR');
    await seedUnresolvedDepositLimit(userId, '100');
    await seedDeposit(userId, '80');

    await makeService().evaluateUser(userId, 'wallet.deposit.completed');

    const [row] = await db.drizzle.db.select().from(userLimit).where(eq(userLimit.userId, userId));
    expect(row?.currency).toBe('EUR');
  });

  it('skips (does not throw) evaluation of a limit whose currency cannot be resolved', async () => {
    const userId = randomUUID();
    await seedUnresolvedDepositLimit(userId, '100');

    await expect(
      makeService().evaluateUser(userId, 'wallet.deposit.completed'),
    ).resolves.toBeUndefined();
    expect(await flagsOf(userId)).toHaveLength(0);
  });
});

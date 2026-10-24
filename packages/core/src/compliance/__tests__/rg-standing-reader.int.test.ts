import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { ExchangeRateReader, PlayEligibilityPort } from '@openora/core/contracts';
import { createTestDb, seedCompletedDeposit, type TestDb } from '@openora/core/testing';
import { player } from '@openora/core/pam/schema/profile';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { migrate as migrateWallet } from '@openora/core/wallet/migrate';
import { walletTransaction } from '@openora/core/wallet/schema';
import { mock } from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { rgExclusion, rgFlag, userLimit } from '../schema/index.js';
import { RgStandingReaderService } from '../adapters/rg-standing-reader.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);
const daysAhead = (days: number) => new Date(Date.now() + days * DAY_MS);
const ADMIN_ID = randomUUID();
const PRICES: Record<string, string> = { BTC: '60000' };

let db: TestDb;

function rates(): ExchangeRateReader {
  return mock<ExchangeRateReader>({
    convert: vi.fn(async (amount: string, from: string, to: string) => {
      if (from === to) {
        return amount;
      }
      const price = PRICES[from];
      return price === undefined ? null : String(Number(amount) * Number(price));
    }),
  });
}

function reader({ restricted = false } = {}) {
  return new RgStandingReaderService({
    drizzle: db.drizzle,
    eligibility: mock<PlayEligibilityPort>({ isRestricted: vi.fn(async () => restricted) }),
    rates: rates(),
    pivotCurrency: 'USD',
  });
}

async function seedPlayer(currency = 'USD') {
  const userId = randomUUID();
  await db.drizzle.db.insert(player).values({ userId, currency });
  return userId;
}

async function seedExclusion(
  userId: string,
  values: Pick<typeof rgExclusion.$inferInsert, 'kind'> & Partial<typeof rgExclusion.$inferInsert>,
) {
  await db.drizzle.db
    .insert(rgExclusion)
    .values({ userId, reason: 'player asked for it', createdBy: ADMIN_ID, ...values });
}

const seedMoney = (
  userId: string,
  values: Partial<typeof walletTransaction.$inferInsert> & { amount: string },
) => seedCompletedDeposit(db, userId, values.amount, values);

beforeAll(async () => {
  db = await createTestDb([migrateProfile, migrateWallet, migrate]);
});

afterAll(async () => {
  await db.drop();
});

describe('RgStandingReaderService.getStanding (real PG)', () => {
  it('answers null for a user without a player profile', async () => {
    expect(await reader().getStanding(randomUUID(), { windowDays: [7] })).toBeNull();
  });

  it('reports a clean player with no exclusions, flags, limits or money', async () => {
    const userId = await seedPlayer();

    expect(await reader().getStanding(userId, { windowDays: [7] })).toEqual({
      restricted: false,
      activeExclusions: [],
      selfExclusionsOnRecord: 0,
      lastSelfExclusionEndedAt: null,
      lastCoolingOffEndedAt: null,
      activeFlags: [],
      limits: [],
      pivotCurrency: 'USD',
      windows: [{ days: 7, totals: { deposits: '0', bets: '0', wins: '0' } }],
    });
  });

  it('reports the play restriction the eligibility port answers', async () => {
    const userId = await seedPlayer();

    const standing = await reader({ restricted: true }).getStanding(userId, { windowDays: [] });

    expect(standing?.restricted).toBe(true);
  });

  it('dates a lifted self-exclusion by its lift and an expired one by when it ran out', async () => {
    const liftedAt = daysAgo(30);
    const lifted = await seedPlayer();
    await seedExclusion(lifted, {
      kind: 'self_exclusion',
      status: 'lifted',
      startsAt: daysAgo(400),
      expiresAt: daysAgo(220),
      liftedAt,
    });
    const ranOutAt = daysAgo(40);
    const expired = await seedPlayer();
    await seedExclusion(expired, {
      kind: 'self_exclusion',
      status: 'expired',
      startsAt: daysAgo(400),
      expiresAt: ranOutAt,
    });
    await seedExclusion(expired, {
      kind: 'self_exclusion',
      status: 'lifted',
      startsAt: daysAgo(900),
      expiresAt: daysAgo(700),
      liftedAt: daysAgo(600),
    });

    expect(await reader().getStanding(lifted, { windowDays: [] })).toMatchObject({
      activeExclusions: [],
      selfExclusionsOnRecord: 1,
      lastSelfExclusionEndedAt: liftedAt,
    });
    expect(await reader().getStanding(expired, { windowDays: [] })).toMatchObject({
      activeExclusions: [],
      selfExclusionsOnRecord: 2,
      lastSelfExclusionEndedAt: ranOutAt,
    });
  });

  it('keeps a self-exclusion past its term in force until it is lifted', async () => {
    const userId = await seedPlayer();
    const startsAt = daysAgo(200);
    const expiresAt = daysAgo(10);
    await seedExclusion(userId, { kind: 'self_exclusion', startsAt, expiresAt });

    expect(await reader().getStanding(userId, { windowDays: [] })).toMatchObject({
      activeExclusions: [{ kind: 'self_exclusion', startsAt, expiresAt, isPermanent: false }],
      selfExclusionsOnRecord: 1,
      lastSelfExclusionEndedAt: null,
    });
  });

  it('ends a cooling-off at its end before the sweep marks it, or at its lift when lifted early', async () => {
    const endedAt = daysAgo(2);
    const lapsed = await seedPlayer();
    await seedExclusion(lapsed, { kind: 'cooling_off', startsAt: daysAgo(5), expiresAt: endedAt });
    await seedExclusion(lapsed, {
      kind: 'cooling_off',
      status: 'lifted',
      startsAt: daysAgo(30),
      expiresAt: daysAgo(10),
      liftedAt: daysAgo(25),
    });
    const liftedAt = daysAgo(3);
    const liftedEarly = await seedPlayer();
    await seedExclusion(liftedEarly, {
      kind: 'cooling_off',
      status: 'lifted',
      startsAt: daysAgo(4),
      expiresAt: daysAhead(10),
      liftedAt,
    });
    const startsAt = daysAgo(1);
    const expiresAt = daysAhead(1);
    const active = await seedPlayer();
    await seedExclusion(active, { kind: 'cooling_off', startsAt, expiresAt });

    expect(await reader().getStanding(lapsed, { windowDays: [] })).toMatchObject({
      activeExclusions: [],
      lastCoolingOffEndedAt: endedAt,
    });
    expect(await reader().getStanding(liftedEarly, { windowDays: [] })).toMatchObject({
      activeExclusions: [],
      lastCoolingOffEndedAt: liftedAt,
    });
    expect(await reader().getStanding(active, { windowDays: [] })).toMatchObject({
      activeExclusions: [{ kind: 'cooling_off', startsAt, expiresAt, isPermanent: false }],
      lastCoolingOffEndedAt: null,
      selfExclusionsOnRecord: 0,
    });
  });

  it('reports a permanent self-exclusion in force with no end', async () => {
    const userId = await seedPlayer();
    const startsAt = daysAgo(3);
    await seedExclusion(userId, { kind: 'self_exclusion', isPermanent: true, startsAt });

    expect(await reader().getStanding(userId, { windowDays: [] })).toMatchObject({
      activeExclusions: [{ kind: 'self_exclusion', startsAt, expiresAt: null, isPermanent: true }],
    });
  });

  it('lists active flags only, by type and limit', async () => {
    const userId = await seedPlayer();
    const flaggedAt = daysAgo(1);
    await db.drizzle.db.insert(rgFlag).values([
      {
        userId,
        flagType: 'limit_threshold',
        limitType: 'deposit',
        detail: { actual: '90', limit: '100', period: 'daily', pct: 90 },
        flaggedAt,
      },
      { userId, flagType: 'session_time', status: 'cleared', clearedAt: daysAgo(0) },
    ]);

    const standing = await reader().getStanding(userId, { windowDays: [] });

    expect(standing?.activeFlags).toEqual([
      { flagType: 'limit_threshold', limitType: 'deposit', flaggedAt },
    ]);
  });

  it("reads a limit stored without a currency in the player's currency and leaves the row as it is", async () => {
    const userId = await seedPlayer('EUR');
    await db.drizzle.db.insert(userLimit).values([
      { userId, type: 'deposit', period: 'daily', amount: '100', currency: null },
      { userId, type: 'wager', period: 'weekly', amount: '0.5', currency: 'BTC' },
      { userId, type: 'session', period: 'session', minutes: 60, currency: 'SESSION' },
    ]);

    const standing = await reader().getStanding(userId, { windowDays: [] });

    expect(standing?.limits).toHaveLength(3);
    expect(standing?.limits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'deposit', period: 'daily', currency: 'EUR' }),
        expect.objectContaining({ type: 'wager', period: 'weekly', currency: 'BTC' }),
        { type: 'session', period: 'session', minutes: 60 },
      ]),
    );
    const [stored] = await db.drizzle.db
      .select({ currency: userLimit.currency })
      .from(userLimit)
      .where(eq(userLimit.userId, userId))
      .orderBy(userLimit.type);
    expect(stored?.currency).toBeNull();
  });

  it('prices every currency of each window into the pivot', async () => {
    const userId = await seedPlayer();
    await seedMoney(userId, { amount: '100' });
    await seedMoney(userId, { amount: '0.01', currency: 'BTC', createdAt: daysAgo(3) });
    await seedMoney(userId, { amount: '50', createdAt: daysAgo(20) });
    await seedMoney(userId, { amount: '70', createdAt: daysAgo(40), reviewedAt: daysAgo(2) });
    await seedMoney(userId, { amount: '999', status: 'pending' });
    await seedMoney(userId, { type: 'bet', amount: '30' });
    await seedMoney(userId, { type: 'bet_reversal', amount: '10' });
    await seedMoney(userId, {
      type: 'bet',
      amount: '0.001',
      currency: 'BTC',
      createdAt: daysAgo(15),
    });
    await seedMoney(userId, { type: 'win', amount: '5' });
    await seedMoney(userId, { type: 'withdrawal', amount: '400' });

    const standing = await reader().getStanding(userId, { windowDays: [7, 30] });

    const totals = standing?.windows.map(({ days, totals: t }) => ({
      days,
      deposits: Number(t?.deposits),
      bets: Number(t?.bets),
      wins: Number(t?.wins),
    }));
    expect(totals).toEqual([
      { days: 7, deposits: 770, bets: 20, wins: 5 },
      { days: 30, deposits: 820, bets: 80, wins: 5 },
    ]);
  });

  it('answers a null window, never a partial one, when a currency in it cannot be priced', async () => {
    const userId = await seedPlayer();
    await seedMoney(userId, { amount: '100' });
    await seedMoney(userId, { amount: '5000', currency: 'DOGE', createdAt: daysAgo(20) });

    const standing = await reader().getStanding(userId, { windowDays: [7, 30] });

    expect(standing?.windows.map(({ days, totals }) => ({ days, known: totals !== null }))).toEqual(
      [
        { days: 7, known: true },
        { days: 30, known: false },
      ],
    );
    expect(Number(standing?.windows[0]?.totals?.deposits)).toBe(100);
  });

  it.each([
    ['more than four windows', [1, 7, 14, 30, 90]],
    ['a zero-day window', [0]],
    ['a window over a year', [366]],
    ['a fractional window', [1.5]],
  ])('refuses %s', async (_label, windowDays) => {
    const userId = await seedPlayer();

    await expect(reader().getStanding(userId, { windowDays })).rejects.toThrow(RangeError);
  });
});

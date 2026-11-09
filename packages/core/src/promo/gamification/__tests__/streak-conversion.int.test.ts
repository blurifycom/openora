import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import type {
  BonusGrantCommands,
  ExchangeRateReader,
  PlayEligibilityPort,
  WalletReader,
} from '@openora/core/contracts';
import { makeAuditWriter, mock } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import {
  promoStreakConfig,
  promoStreakDailyWager,
  promoStreakMilestoneGrant,
  promoStreakRoundWager,
} from '../schema/index.js';
import {
  StreakMilestoneNotClaimableError,
  StreakPayoutService,
} from '../service/streak-payout.service.js';

const CONVERSION = readFileSync(
  new URL('../drizzle/migrations/0023_streak_milestone_conversion.sql', import.meta.url),
  'utf8',
)
  .split('--> statement-breakpoint')
  .map((statement) => statement.trim())
  .filter((statement) => statement.length > 0);

const DAY_MS = 86_400_000;

let db: TestDb;
const audit = makeAuditWriter();
const grant = vi.fn<BonusGrantCommands['grant']>();

const payouts = () =>
  new StreakPayoutService({
    drizzle: db.drizzle,
    grants: mock<BonusGrantCommands>({ grant }),
    eligibility: mock<PlayEligibilityPort>({ isRestricted: async () => false }),
    rates: mock<ExchangeRateReader>({ convert: async () => null }),
    walletReader: mock<WalletReader>({
      getBalances: async () => ({ activeCurrency: 'USD', balances: [] }),
    }),
    audit,
    logger: { error: vi.fn() },
  });

const runConversion = async () => {
  for (const statement of CONVERSION) {
    await db.drizzle.db.execute(sql.raw(statement));
  }
};

const bonus = (
  amount: string,
  wageringMultiplier: string,
  expiryDays: number,
  maxBet?: string,
) => ({
  kind: 'bonus',
  amount,
  terms: { wageringMultiplier, expiryDays, ...(maxBet === undefined ? {} : { maxBet }) },
});

const legacyConfig = (milestones: unknown[], currency = 'USD') =>
  db.drizzle.db.execute(sql`
    INSERT INTO promo_streak_config (currency, daily_min_wager, enabled, milestones, reset_after_day)
    VALUES (${currency}, '10', true, ${JSON.stringify(milestones)}::jsonb, 30)
  `);

const unsettledGrant = async (userId: string, day: number) => {
  const [row] = await db.drizzle.db
    .insert(promoStreakMilestoneGrant)
    .values({ userId, day })
    .returning({ id: promoStreakMilestoneGrant.id });
  return row?.id ?? '';
};

const grantRow = async (id: string) => {
  const [row] = await db.drizzle.db
    .select()
    .from(promoStreakMilestoneGrant)
    .where(eq(promoStreakMilestoneGrant.id, id));
  return row;
};

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(() => db.drop());

beforeEach(async () => {
  vi.clearAllMocks();
  await db.drizzle.db.delete(promoStreakMilestoneGrant);
  await db.drizzle.db.delete(promoStreakRoundWager);
  await db.drizzle.db.delete(promoStreakDailyWager);
  await db.drizzle.db.delete(promoStreakConfig);
});

describe('converting the old milestone config', () => {
  it('runs on empty tables', async () => {
    await expect(runConversion()).resolves.toBeUndefined();
  });

  it('switches the streak off and turns each bonus reward into a fixed reward, leaving no rates', async () => {
    await legacyConfig([
      {
        day: 21,
        rewards: [{ kind: 'giftDrop', min: '1', max: '2', terms: {} }, bonus('50', '10', 20)],
      },
      { day: 3, rewards: [{ kind: 'cash', amount: '5' }] },
      { day: 7, rewards: [bonus('10', '5', 30)] },
    ]);

    await runConversion();

    const [config] = await db.drizzle.db.select().from(promoStreakConfig);
    expect(config).toMatchObject({
      enabled: false,
      rakebackMilestones: [],
      fixedRewards: [
        { day: 7, amount: '10', rolloverMultiplier: '5', claimExpiryDays: 30, maxBet: null },
        { day: 21, amount: '50', rolloverMultiplier: '10', claimExpiryDays: 20, maxBet: null },
      ],
    });
  });

  it('empties the old milestone list, so a pod still running the old code unlocks and pays nothing', async () => {
    await legacyConfig([{ day: 7, rewards: [bonus('10', '5', 30)] }]);

    await runConversion();

    const [config] = await db.drizzle.db.select().from(promoStreakConfig);
    expect(config?.milestones).toEqual([]);
  });

  it('keeps the max bet of the old bonus terms, and drops one that is not above zero', async () => {
    await legacyConfig([
      { day: 3, rewards: [bonus('10', '5', 30, '2')] },
      { day: 7, rewards: [bonus('10', '5', 30, '0')] },
    ]);

    await runConversion();

    const [config] = await db.drizzle.db.select().from(promoStreakConfig);
    expect(config?.fixedRewards).toEqual([
      expect.objectContaining({ day: 3, maxBet: '2' }),
      expect.objectContaining({ day: 7, maxBet: null }),
    ]);
  });

  it('takes the first bonus reward in the order the milestone lists them', async () => {
    await legacyConfig([
      {
        day: 7,
        rewards: [
          { kind: 'giftDrop', min: '1', max: '2', terms: {} },
          bonus('10', '5', 30),
          bonus('99', '5', 30),
        ],
      },
    ]);

    await runConversion();

    const [config] = await db.drizzle.db.select().from(promoStreakConfig);
    expect(config?.fixedRewards).toEqual([expect.objectContaining({ day: 7, amount: '10' })]);
  });

  it('gives a waiting grant the max bet of its matching reward', async () => {
    await legacyConfig([{ day: 7, rewards: [bonus('10', '5', 30, '2')] }]);
    const id = await unsettledGrant(randomUUID(), 7);

    await runConversion();

    expect((await grantRow(id))?.maxBet).toBe('2.000000000000000000');
  });

  it.each([
    ['a day beyond 35', { day: 40, rewards: [bonus('10', '5', 30)] }],
    ['a zero amount', { day: 7, rewards: [bonus('0', '5', 30)] }],
    ['a zero rollover', { day: 7, rewards: [bonus('10', '0', 30)] }],
    ['a rollover above the engine limit', { day: 7, rewards: [bonus('10', '1001', 30)] }],
    ['a zero expiry', { day: 7, rewards: [bonus('10', '5', 0)] }],
    ['an expiry above a year', { day: 7, rewards: [bonus('10', '5', 366)] }],
  ])('drops a reward the new rules would refuse: %s', async (_label, milestone) => {
    await legacyConfig([milestone]);

    await runConversion();

    const [config] = await db.drizzle.db.select().from(promoStreakConfig);
    expect(config?.fixedRewards).toEqual([]);
  });

  it('gives an unsettled reward the matching fixed reward, expiring a claim window from now', async () => {
    await legacyConfig([{ day: 7, rewards: [bonus('10', '5', 30)] }]);
    const id = await unsettledGrant(randomUUID(), 7);
    const before = Date.now();

    await runConversion();

    const row = await grantRow(id);
    expect(row).toMatchObject({
      settledAt: null,
      outcome: null,
      amount: '10.000000000000000000',
      rolloverMultiplier: '5.000000000000000000',
      claimExpiryDays: 30,
    });
    expect(row?.expiresAt?.getTime()).toBeGreaterThanOrEqual(before + 30 * DAY_MS - 1000);
    expect(row?.expiresAt?.getTime()).toBeLessThanOrEqual(Date.now() + 30 * DAY_MS + 1000);
  });

  it('leaves a waiting reward with no matching fixed reward for the expiry sweep, which audits it', async () => {
    await legacyConfig([
      { day: 3, rewards: [{ kind: 'cash', amount: '5' }] },
      { day: 7, rewards: [bonus('10', '5', 30)] },
    ]);
    const userId = randomUUID();
    const cashOnly = await unsettledGrant(userId, 3);
    const unlisted = await unsettledGrant(randomUUID(), 12);

    await runConversion();

    expect(await grantRow(cashOnly)).toMatchObject({
      settledAt: null,
      outcome: null,
      amount: null,
      expiresAt: null,
    });
    expect(audit.recordManyInTransaction).not.toHaveBeenCalled();

    await expect(payouts().expireDue(new Date())).resolves.toBe(2);

    expect(await grantRow(cashOnly)).toMatchObject({ outcome: 'expired' });
    expect(await grantRow(unlisted)).toMatchObject({ outcome: 'expired' });
    const entries = audit.recordManyInTransaction.mock.calls.flatMap(([, rows]) => rows);
    expect(entries).toHaveLength(2);
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'promo.streak.milestone.expired', resourceId: cashOnly }),
        expect.objectContaining({ action: 'promo.streak.milestone.expired', resourceId: unlisted }),
      ]),
    );
  });

  it('keeps an unmapped waiting reward out of reach of a claim and of an announcement', async () => {
    await legacyConfig([{ day: 7, rewards: [bonus('10', '5', 30)] }]);
    const userId = randomUUID();
    const id = await unsettledGrant(userId, 3);
    await runConversion();

    await expect(payouts().claim(userId, id)).rejects.toBeInstanceOf(
      StreakMilestoneNotClaimableError,
    );
    const announced: unknown[] = [];
    await payouts().announceReached((reached) => announced.push(reached));

    expect(announced).toEqual([]);
    expect(grant).not.toHaveBeenCalled();
    expect(await grantRow(id)).toMatchObject({ settledAt: null, outcome: null });
  });

  it('leaves a waiting reward for the expiry sweep when the old config is gone', async () => {
    const id = await unsettledGrant(randomUUID(), 7);

    await runConversion();

    expect(await grantRow(id)).toMatchObject({ settledAt: null, expiresAt: null });
    await expect(payouts().expireDue(new Date())).resolves.toBe(1);
  });

  it('leaves a reward that was already settled exactly as it was', async () => {
    await legacyConfig([{ day: 7, rewards: [bonus('10', '5', 30)] }]);
    const [settled] = await db.drizzle.db
      .insert(promoStreakMilestoneGrant)
      .values({ userId: randomUUID(), day: 7, settledAt: new Date(), outcome: 'granted' })
      .returning();

    await runConversion();

    expect(await grantRow(settled?.id ?? '')).toEqual(settled);
  });
});

describe('converting a config that was not priced in dollars', () => {
  const eurMilestones = [{ day: 7, rewards: [bonus('10', '5', 30, '2')] }];

  it('maps no reward, since the old amounts cannot be read as dollars', async () => {
    await legacyConfig(eurMilestones, 'EUR');

    await runConversion();

    const [config] = await db.drizzle.db.select().from(promoStreakConfig);
    expect(config).toMatchObject({ enabled: false, currency: 'EUR', fixedRewards: [] });
  });

  it('leaves a waiting reward unmapped, so it expires through the sweep', async () => {
    await legacyConfig(eurMilestones, 'EUR');
    const id = await unsettledGrant(randomUUID(), 7);

    await runConversion();

    expect(await grantRow(id)).toMatchObject({
      settledAt: null,
      amount: null,
      maxBet: null,
      expiresAt: null,
    });
    await expect(payouts().expireDue(new Date())).resolves.toBe(1);
  });

  it('drops the day totals and round shares counted in the old currency', async () => {
    await legacyConfig(eurMilestones, 'EUR');
    const userId = randomUUID();
    const day = new Date().toISOString().slice(0, 10);
    await db.drizzle.db
      .insert(promoStreakDailyWager)
      .values({ userId, day, currency: 'EUR', wagered: '100' });
    await db.drizzle.db.insert(promoStreakRoundWager).values({
      userId,
      providerName: 'aggregator',
      currency: 'EUR',
      externalRoundId: 'round-1',
      day,
      stake: '100',
      wagered: '100',
    });

    await runConversion();

    expect(await db.drizzle.db.select().from(promoStreakDailyWager)).toEqual([]);
    expect(await db.drizzle.db.select().from(promoStreakRoundWager)).toEqual([]);
  });

  it('keeps the day totals and round shares of a config that was already in dollars', async () => {
    await legacyConfig(eurMilestones);
    const userId = randomUUID();
    const day = new Date().toISOString().slice(0, 10);
    await db.drizzle.db
      .insert(promoStreakDailyWager)
      .values({ userId, day, currency: 'USD', wagered: '100' });
    await db.drizzle.db.insert(promoStreakRoundWager).values({
      userId,
      providerName: 'aggregator',
      currency: 'EUR',
      externalRoundId: 'round-1',
      day,
      stake: '90',
      wagered: '100',
    });

    await runConversion();

    expect(await db.drizzle.db.select().from(promoStreakDailyWager)).toHaveLength(1);
    expect(await db.drizzle.db.select().from(promoStreakRoundWager)).toHaveLength(1);
  });
});

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate } from '../migrate.js';
import { promoStreakConfig, promoStreakMilestoneGrant } from '../schema/index.js';

const CONVERSION = readFileSync(
  new URL('../drizzle/migrations/0023_streak_milestone_conversion.sql', import.meta.url),
  'utf8',
)
  .split('--> statement-breakpoint')
  .map((statement) => statement.trim())
  .filter((statement) => statement.length > 0);

const DAY_MS = 86_400_000;

let db: TestDb;

const runConversion = async () => {
  for (const statement of CONVERSION) {
    await db.drizzle.db.execute(sql.raw(statement));
  }
};

const bonus = (amount: string, wageringMultiplier: string, expiryDays: number) => ({
  kind: 'bonus',
  amount,
  terms: { wageringMultiplier, expiryDays },
});

const legacyConfig = (milestones: unknown[]) =>
  db.drizzle.db.execute(sql`
    INSERT INTO promo_streak_config (currency, daily_min_wager, enabled, milestones, reset_after_day)
    VALUES ('USD', '10', true, ${JSON.stringify(milestones)}::jsonb, 30)
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
  await db.drizzle.db.delete(promoStreakMilestoneGrant);
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
      currency: 'USD',
      rakebackMilestones: [],
      fixedRewards: [
        { day: 7, amount: '10', rolloverMultiplier: '5', claimExpiryDays: 30 },
        { day: 21, amount: '50', rolloverMultiplier: '10', claimExpiryDays: 20 },
      ],
    });
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

  it('settles an unsettled reward with no matching fixed reward as expired', async () => {
    await legacyConfig([
      { day: 3, rewards: [{ kind: 'cash', amount: '5' }] },
      { day: 7, rewards: [bonus('10', '5', 30)] },
    ]);
    const cashOnly = await unsettledGrant(randomUUID(), 3);
    const unlisted = await unsettledGrant(randomUUID(), 12);

    await runConversion();

    expect(await grantRow(cashOnly)).toMatchObject({ outcome: 'expired', amount: null });
    expect((await grantRow(cashOnly))?.settledAt).toBeInstanceOf(Date);
    expect(await grantRow(unlisted)).toMatchObject({ outcome: 'expired' });
  });

  it('settles every unsettled reward as expired when the old config is gone', async () => {
    const id = await unsettledGrant(randomUUID(), 7);

    await runConversion();

    expect(await grantRow(id)).toMatchObject({ outcome: 'expired' });
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

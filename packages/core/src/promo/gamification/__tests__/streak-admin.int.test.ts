import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { makeAuditWriter } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import {
  promoPlayerStreak,
  promoStreakConfig,
  promoStreakMilestoneGrant,
} from '../schema/index.js';
import { StreakAdminService } from '../service/streak-admin.service.js';
import { StreakConfigNotSetError } from '../service/streak.service.js';
import type { StreakConfig } from '../contract/index.js';

let db: TestDb;
const audit = makeAuditWriter();

const CONFIG: StreakConfig = {
  enabled: true,
  dailyMinWager: '25',
  eligibleProducts: ['casino', 'live-casino'],
  rakebackMilestones: [{ day: 3, unrankedRatePercent: '2', rankedUpliftPercent: '10' }],
  fixedRewards: [{ day: 7, amount: '10', rolloverMultiplier: '5', claimExpiryDays: 14 }],
};

const admin = () => new StreakAdminService(db.drizzle, audit);

const stored = async () => {
  const [row] = await db.drizzle.db.select().from(promoStreakConfig);
  return row;
};

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(() => db.drop());

beforeEach(async () => {
  audit.recordInTransaction.mockClear();
  await db.drizzle.db.delete(promoStreakMilestoneGrant);
  await db.drizzle.db.delete(promoPlayerStreak);
  await db.drizzle.db.delete(promoStreakConfig);
});

describe('reading the streak config', () => {
  it('reports that nothing is configured yet', async () => {
    await expect(admin().getConfig()).rejects.toBeInstanceOf(StreakConfigNotSetError);
  });

  it('returns what was saved', async () => {
    await admin().setConfig(randomUUID(), CONFIG);
    expect(await admin().getConfig()).toEqual({
      ...CONFIG,
      dailyMinWager: '25.000000000000000000',
    });
  });
});

describe('saving the streak config', () => {
  it('stores the config in dollars and attributes it to the staff member', async () => {
    const adminId = randomUUID();

    await admin().setConfig(adminId, CONFIG);

    expect(await stored()).toMatchObject({
      ...CONFIG,
      dailyMinWager: '25.000000000000000000',
      currency: 'USD',
      updatedBy: adminId,
    });
  });

  it('replaces the previous config as one unit', async () => {
    const adminId = randomUUID();
    await admin().setConfig(adminId, CONFIG);

    await admin().setConfig(adminId, {
      ...CONFIG,
      rakebackMilestones: [],
      fixedRewards: [{ day: 1, amount: '1', rolloverMultiplier: '1', claimExpiryDays: 1 }],
    });

    expect(await db.drizzle.db.select().from(promoStreakConfig)).toHaveLength(1);
    expect(await admin().getConfig()).toMatchObject({
      rakebackMilestones: [],
      fixedRewards: [{ day: 1 }],
    });
  });

  it('keeps each product once', async () => {
    await admin().setConfig(randomUUID(), { ...CONFIG, eligibleProducts: ['casino', 'casino'] });
    expect((await stored())?.eligibleProducts).toEqual(['casino']);
  });

  it('audits the change with the staff identity, the client and the before and after', async () => {
    const adminId = randomUUID();
    await admin().setConfig(adminId, CONFIG);

    await admin().setConfig(
      adminId,
      { ...CONFIG, enabled: false },
      { ip: '203.0.113.9', userAgent: 'backoffice' },
    );

    expect(audit.recordInTransaction).toHaveBeenCalledTimes(2);
    expect(audit.recordInTransaction.mock.calls[1]?.[1]).toMatchObject({
      actorId: adminId,
      actorType: 'admin',
      action: 'promo.streak_config.set',
      resourceType: 'promo_streak_config',
      before: { enabled: true, dailyMinWager: '25.000000000000000000' },
      after: { enabled: false },
      ip: '203.0.113.9',
      userAgent: 'backoffice',
    });
  });

  it('saves nothing when the audit write fails', async () => {
    audit.recordInTransaction.mockRejectedValueOnce(new Error('audit unavailable'));

    await expect(admin().setConfig(randomUUID(), CONFIG)).rejects.toThrow(/audit unavailable/);

    expect(await stored()).toBeUndefined();
  });

  it('is prospective: a reward already unlocked keeps the terms it was unlocked under', async () => {
    const userId = randomUUID();
    await admin().setConfig(randomUUID(), CONFIG);
    const [unlocked] = await db.drizzle.db
      .insert(promoStreakMilestoneGrant)
      .values({
        userId,
        day: 7,
        amount: '10',
        rolloverMultiplier: '5',
        claimExpiryDays: 14,
        expiresAt: new Date(Date.now() + 14 * 86_400_000),
      })
      .returning();

    await admin().setConfig(randomUUID(), {
      ...CONFIG,
      fixedRewards: [{ day: 7, amount: '999', rolloverMultiplier: '99', claimExpiryDays: 1 }],
    });

    const [after] = await db.drizzle.db
      .select()
      .from(promoStreakMilestoneGrant)
      .where(eq(promoStreakMilestoneGrant.id, unlocked?.id ?? ''));
    expect(after).toEqual(unlocked);
  });
});

describe('switching the streak on', () => {
  const run = (userId: string, current: number) =>
    db.drizzle.db
      .insert(promoPlayerStreak)
      .values({ userId, current, best: current, lastQualifyingDay: '2020-01-01' });

  const currentOf = async (userId: string) => {
    const [row] = await db.drizzle.db
      .select({ current: promoPlayerStreak.current, best: promoPlayerStreak.best })
      .from(promoPlayerStreak)
      .where(eq(promoPlayerStreak.userId, userId));
    return row;
  };

  it('starts every run from zero when it was off, keeping the best', async () => {
    const userId = randomUUID();
    await admin().setConfig(randomUUID(), { ...CONFIG, enabled: false });
    await run(userId, 6);

    await admin().setConfig(randomUUID(), CONFIG);

    expect(await currentOf(userId)).toEqual({ current: 0, best: 6 });
    expect(audit.recordInTransaction.mock.calls.at(-1)?.[1]).toMatchObject({
      after: { enabled: true, streaksReset: 1 },
    });
  });

  it('forgets the last qualifying day too, so a player who qualified today can advance again', async () => {
    const userId = randomUUID();
    await admin().setConfig(randomUUID(), { ...CONFIG, enabled: false });
    await db.drizzle.db.insert(promoPlayerStreak).values({
      userId,
      current: 4,
      best: 4,
      lastQualifyingDay: new Date().toISOString().slice(0, 10),
    });

    await admin().setConfig(randomUUID(), CONFIG);

    const [row] = await db.drizzle.db
      .select({ lastQualifyingDay: promoPlayerStreak.lastQualifyingDay })
      .from(promoPlayerStreak)
      .where(eq(promoPlayerStreak.userId, userId));
    expect(row?.lastQualifyingDay).toBeNull();
  });

  it('starts every run from zero the first time the streak is configured on', async () => {
    const userId = randomUUID();
    await run(userId, 6);

    await admin().setConfig(randomUUID(), CONFIG);

    expect((await currentOf(userId))?.current).toBe(0);
  });

  it('leaves runs alone when an edit keeps it on', async () => {
    const userId = randomUUID();
    await admin().setConfig(randomUUID(), CONFIG);
    await run(userId, 6);

    await admin().setConfig(randomUUID(), { ...CONFIG, dailyMinWager: '50' });

    expect((await currentOf(userId))?.current).toBe(6);
  });

  it('leaves runs alone when it is switched off, for the next close to reset', async () => {
    const userId = randomUUID();
    await admin().setConfig(randomUUID(), CONFIG);
    await run(userId, 6);

    await admin().setConfig(randomUUID(), { ...CONFIG, enabled: false });

    expect((await currentOf(userId))?.current).toBe(6);
  });
});

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { mock } from '../../../testing/mock.js';
import type {
  BonusGrantCommands,
  ExchangeRateReader,
  PlayEligibilityPort,
} from '@openora/core/contracts';
import { migrate } from '../migrate.js';
import {
  promoPlayerRank,
  promoRankConfig,
  promoRankLevelUp,
  promoRankTier,
} from '../schema/index.js';
import { DEFAULT_PAYOUT_ANCHORS } from '../contract/index.js';
import { seedRankLadder } from '../seed/index.js';
import { RankPayoutService } from '../service/rank-payout.service.js';

let db: TestDb;
const grant = vi.fn<BonusGrantCommands['grant']>();
const isRestricted = vi.fn<PlayEligibilityPort['isRestricted']>();
const convert = vi.fn<ExchangeRateReader['convert']>();
const logger = { warn: vi.fn(), error: vi.fn() };

const LEVEL_UP_TERMS = { wageringMultiplier: '3', expiryDays: 7 };
const DAILY_TERMS = { wageringMultiplier: '1', expiryDays: 1 };
const NOW = new Date('2026-09-22T00:00:00Z');
const YESTERDAY_NOON = new Date('2026-09-21T12:00:00Z');
const TWO_DAYS_AGO = new Date('2026-09-20T12:00:00Z');

const service = () =>
  new RankPayoutService(
    db.drizzle,
    mock<BonusGrantCommands>({ grant }),
    mock<PlayEligibilityPort>({ isRestricted }),
    mock<ExchangeRateReader>({ convert }),
    logger,
  );

const tierId = async (key: string) => {
  const [tier] = await db.drizzle.db
    .select({ id: promoRankTier.id })
    .from(promoRankTier)
    .where(eq(promoRankTier.key, key));
  if (!tier) {
    throw new Error(`no tier ${key}`);
  }
  return tier.id;
};

const owe = async (userId: string, key: string, amount: string) => {
  const [row] = await db.drizzle.db
    .insert(promoRankLevelUp)
    .values({ userId, tierId: await tierId(key), currency: 'USD', amount })
    .returning({ id: promoRankLevelUp.id });
  return row?.id ?? '';
};

const levelUp = async (id: string) => {
  const [row] = await db.drizzle.db
    .select({
      settledAt: promoRankLevelUp.settledAt,
      outcome: promoRankLevelUp.outcome,
      grantId: promoRankLevelUp.grantId,
    })
    .from(promoRankLevelUp)
    .where(eq(promoRankLevelUp.id, id));
  return row;
};

const holding = async (key: string, lastWageredAt: Date | null) => {
  const userId = randomUUID();
  await db.drizzle.db.insert(promoPlayerRank).values({
    userId,
    currency: 'USD',
    lifetimeWagered: '0',
    tierId: await tierId(key),
    lastWageredAt,
  });
  return userId;
};

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(() => db.drop());

beforeEach(async () => {
  vi.clearAllMocks();
  grant.mockImplementation(async () => ({ ok: true, grantId: randomUUID(), created: true }));
  isRestricted.mockResolvedValue(false);
  convert.mockResolvedValue(null);
  await db.drizzle.db.delete(promoRankLevelUp);
  await db.drizzle.db.delete(promoPlayerRank);
  await db.drizzle.db.delete(promoRankTier);
  await db.drizzle.db.delete(promoRankConfig);
  await seedRankLadder(db.drizzle.db, {
    currency: 'USD',
    tiers: [
      { key: 'bronze', name: 'Bronze', wagerThreshold: '0', rakebackPercent: '1' },
      {
        key: 'silver',
        name: 'Silver',
        wagerThreshold: '100',
        rakebackPercent: '3',
        dailyBonus: '0.5',
      },
    ],
    config: {
      eligibleProducts: [],
      rewards: { levelUp: LEVEL_UP_TERMS, daily: DAILY_TERMS },
      payoutAnchors: DEFAULT_PAYOUT_ANCHORS,
    },
  });
});

describe('settling owed level-up bonuses', () => {
  it('grants each one under the level-up terms, keyed by tier, and announces it', async () => {
    const userId = randomUUID();
    const id = await owe(userId, 'silver', '10');

    const granted = await service().settleLevelUps();

    expect(grant).toHaveBeenCalledTimes(1);
    expect(grant).toHaveBeenCalledWith(expect.anything(), {
      userId,
      currency: 'USD',
      amount: '10.000000000000000000',
      source: 'rank',
      sourceRef: `rank-level-up:${await tierId('silver')}`,
      actor: { type: 'system' },
      terms: LEVEL_UP_TERMS,
    });
    expect(granted).toEqual([
      expect.objectContaining({
        userId,
        source: 'rank',
        grantedAmount: '10.000000000000000000',
        wageringRequired: '30.000000000000000000',
        offerId: null,
      }),
    ]);
    expect(await levelUp(id)).toEqual({
      settledAt: expect.any(Date),
      outcome: 'granted',
      grantId: granted[0]?.grantId,
    });
  });

  it('pays nothing twice when the job runs again', async () => {
    await owe(randomUUID(), 'silver', '10');

    await service().settleLevelUps();
    await service().settleLevelUps();

    expect(grant).toHaveBeenCalledTimes(1);
  });

  it('forfeits the bonus of a player under a responsible-gambling block', async () => {
    const id = await owe(randomUUID(), 'silver', '10');
    isRestricted.mockResolvedValue(true);

    const granted = await service().settleLevelUps();

    expect(granted).toEqual([]);
    expect(grant).not.toHaveBeenCalled();
    expect(await levelUp(id)).toMatchObject({ outcome: 'restricted', grantId: null });
  });

  it('pays nothing and settles nothing while no level-up terms are configured', async () => {
    const id = await owe(randomUUID(), 'silver', '10');
    await db.drizzle.db.update(promoRankConfig).set({ rewards: {} });

    await service().settleLevelUps();

    expect(grant).not.toHaveBeenCalled();
    expect((await levelUp(id))?.settledAt).toBeNull();
  });

  it('pays nothing when a block cannot be checked', async () => {
    const id = await owe(randomUUID(), 'silver', '10');

    const unchecked = new RankPayoutService(
      db.drizzle,
      mock<BonusGrantCommands>({ grant }),
      undefined,
      mock<ExchangeRateReader>({ convert }),
      logger,
    );

    await unchecked.settleLevelUps();

    expect(grant).not.toHaveBeenCalled();
    expect((await levelUp(id))?.settledAt).toBeNull();
  });

  it('leaves a failed payout owed without stopping the rest', async () => {
    const failing = await owe(randomUUID(), 'silver', '10');
    const paying = await owe(randomUUID(), 'silver', '10');
    grant.mockRejectedValueOnce(new Error('boom'));

    await service().settleLevelUps();

    expect((await levelUp(failing))?.settledAt).toBeNull();
    expect(await levelUp(paying)).toMatchObject({ outcome: 'granted' });
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});

describe('paying a periodic bonus', () => {
  it('pays the rank amount for the last complete day to a player active in it', async () => {
    const userId = await holding('silver', YESTERDAY_NOON);

    const granted = await service().payPeriodic('daily', NOW);

    expect(grant).toHaveBeenCalledWith(expect.anything(), {
      userId,
      currency: 'USD',
      amount: '0.500000000000000000',
      source: 'rank',
      sourceRef: 'rank-daily:2026-09-21T00',
      actor: { type: 'system' },
      terms: DAILY_TERMS,
    });
    expect(granted).toHaveLength(1);
  });

  it('skips a player idle in the period, a rank that pays nothing, and a blocked player', async () => {
    await holding('silver', TWO_DAYS_AGO);
    await holding('silver', null);
    await holding('bronze', YESTERDAY_NOON);
    const blocked = await holding('silver', YESTERDAY_NOON);
    isRestricted.mockImplementation(async (userId) => userId === blocked);

    const granted = await service().payPeriodic('daily', NOW);

    expect(granted).toEqual([]);
    expect(grant).not.toHaveBeenCalled();
  });

  it('pays a closed period once, and skips it on every later run', async () => {
    await holding('silver', YESTERDAY_NOON);

    const first = await service().payPeriodic('daily', NOW);
    const second = await service().payPeriodic('daily', NOW);

    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
    expect(grant).toHaveBeenCalledTimes(1);
  });

  it('pays the window the operator anchored, not the calendar one', async () => {
    const userId = await holding('silver', YESTERDAY_NOON);
    await db.drizzle.db
      .update(promoRankConfig)
      .set({ payoutAnchors: { dailyHour: 6, weeklyDay: 1, monthlyDay: 1 } });

    // 04:00 is before the 06:00 anchor, so the day that closed is the one before yesterday.
    await service().payPeriodic('daily', new Date('2026-09-22T04:00:00Z'));

    expect(grant).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId, sourceRef: 'rank-daily:2026-09-20T06' }),
    );
  });

  it('credits the payout currency the operator named, converted at the rate of the payout', async () => {
    const userId = await holding('silver', YESTERDAY_NOON);
    await db.drizzle.db.update(promoRankConfig).set({ payoutCurrency: 'USDT' });
    convert.mockResolvedValue('0.480000000000000000');

    const granted = await service().payPeriodic('daily', NOW);

    expect(convert).toHaveBeenCalledWith('0.500000000000000000', 'USD', 'USDT');
    expect(grant).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId,
        currency: 'USDT',
        amount: '0.480000000000000000',
      }),
    );
    expect(granted[0]).toMatchObject({
      currency: 'USDT',
      grantedAmount: '0.480000000000000000',
      // The requirement follows the amount that was actually credited, not the priced one.
      wageringRequired: '0.480000000000000000',
    });
  });

  it('pays nothing at all when the payout currency has no rate', async () => {
    await holding('silver', YESTERDAY_NOON);
    await db.drizzle.db.update(promoRankConfig).set({ payoutCurrency: 'USDT' });
    convert.mockResolvedValue(null);

    const granted = await service().payPeriodic('daily', NOW);

    expect(granted).toEqual([]);
    expect(grant).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('pays nothing for a kind with no terms configured', async () => {
    await holding('silver', YESTERDAY_NOON);

    const granted = await service().payPeriodic('weekly', NOW);

    expect(granted).toEqual([]);
    expect(grant).not.toHaveBeenCalled();
  });

  it('does not announce a grant the guard matched to an earlier run', async () => {
    await holding('silver', YESTERDAY_NOON);
    grant.mockResolvedValue({ ok: true, grantId: randomUUID(), created: false });

    expect(await service().payPeriodic('daily', NOW)).toEqual([]);
  });

  it('keeps paying the rest when one player fails', async () => {
    const first = await holding('silver', YESTERDAY_NOON);
    await holding('silver', YESTERDAY_NOON);
    grant.mockImplementation(async (_tx, args) =>
      args.userId === first
        ? { ok: false, reason: 'currency_unsupported' }
        : { ok: true, grantId: randomUUID(), created: true },
    );

    const granted = await service().payPeriodic('daily', NOW);

    expect(granted).toHaveLength(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});

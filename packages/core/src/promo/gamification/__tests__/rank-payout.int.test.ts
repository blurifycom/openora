import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { mock } from '../../../testing/mock.js';
import type { BonusGrantCommands, PlayEligibilityPort } from '@openora/core/contracts';
import { migrate } from '../migrate.js';
import { promoRankConfig, promoRankLevelUp, promoRankTier } from '../schema/index.js';
import { seedRankLadder } from '../seed/index.js';
import { RankPayoutService } from '../service/rank-payout.service.js';

let db: TestDb;
const grant = vi.fn<BonusGrantCommands['grant']>();
const isRestricted = vi.fn<PlayEligibilityPort['isRestricted']>();
const logger = { warn: vi.fn(), error: vi.fn() };

const LEVEL_UP_TERMS = { wageringMultiplier: '3', expiryDays: 7 };

const service = () =>
  new RankPayoutService(
    db.drizzle,
    mock<BonusGrantCommands>({ grant }),
    mock<PlayEligibilityPort>({ isRestricted }),
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
    .values({ userId, tierId: await tierId(key), currency: 'USDT', amount })
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

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(() => db.drop());

beforeEach(async () => {
  vi.clearAllMocks();
  grant.mockImplementation(async () => ({ ok: true, grantId: randomUUID(), created: true }));
  isRestricted.mockResolvedValue(false);
  await db.drizzle.db.delete(promoRankLevelUp);
  await db.drizzle.db.delete(promoRankTier);
  await db.drizzle.db.delete(promoRankConfig);
  await seedRankLadder(db.drizzle.db, {
    currency: 'USDT',
    tiers: [
      { key: 'bronze', name: 'Bronze', wagerThreshold: '0', rakebackPercent: '1' },
      {
        key: 'silver',
        name: 'Silver',
        wagerThreshold: '100',
        rakebackPercent: '3',
      },
    ],
    config: {
      eligibleProducts: [],
      rewards: { levelUp: LEVEL_UP_TERMS },
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
      currency: 'USDT',
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

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type {
  ExchangeRateReader,
  SettledWagerArgs,
  WagerContext,
  WagerTrackingArgs,
} from '@openora/core/contracts';
import type { DrizzleTx } from '@openora/core/server';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate } from '../migrate.js';
import {
  promoPlayerRank,
  promoPlayerStreak,
  promoRakebackAccrual,
  promoRankConfig,
  promoRankTier,
  promoStreakConfig,
} from '../schema/index.js';
import { RakebackService } from '../service/rakeback.service.js';
import { unclaimedRakeback } from '../shared/rakeback-totals.js';
import { isoDate } from '../shared/streak-day.js';

const CURRENCY = 'USD';
const PROVIDER = 'sportsbook-int';
const RTP = '0.96';

let db: TestDb;
let bronzeId: string;
let silverId: string;

const claimMode = () =>
  new RakebackService(
    () => undefined,
    { warn: () => undefined },
    { recordManyInTransaction: async () => undefined },
    { basis: 'stake', payout: 'claim' },
  );

const inTx = <T>(work: (tx: DrizzleTx) => Promise<T>) => db.drizzle.db.transaction(work);

const contextOf = (overrides: Partial<WagerContext> = {}): WagerContext => ({
  provider: PROVIDER,
  product: 'sportsbook',
  rtp: RTP,
  ...overrides,
});

const argsFor = (
  userId: string,
  realAmount: string,
  roundId: string = randomUUID(),
  context: WagerContext = contextOf(),
): WagerTrackingArgs => ({
  userId,
  currency: CURRENCY,
  amount: realAmount,
  weightedAmount: realAmount,
  realAmount,
  context,
  round: { providerName: PROVIDER, externalRoundId: roundId },
});

const settledArgs = (
  userId: string,
  realAmount: string,
  roundId: string = randomUUID(),
): SettledWagerArgs => ({
  userId,
  currency: CURRENCY,
  realAmount,
  context: contextOf(),
  round: { providerName: PROVIDER, externalRoundId: roundId },
  qualifiedAt: new Date(),
});

const accrualsOf = (userId: string) =>
  db.drizzle.db.select().from(promoRakebackAccrual).where(eq(promoRakebackAccrual.userId, userId));

async function rankedPlayer(tierId: string) {
  const id = randomUUID();
  await db.drizzle.db.insert(promoPlayerRank).values({ userId: id, currency: CURRENCY, tierId });
  return id;
}

beforeAll(async () => {
  db = await createTestDb([migrate]);
  const tiers = await db.drizzle.db
    .insert(promoRankTier)
    .values([
      {
        key: 'bronze',
        name: 'Bronze',
        position: 0,
        currency: CURRENCY,
        wagerThreshold: '0',
        rakebackPercent: '5',
      },
      {
        key: 'silver',
        name: 'Silver',
        position: 1,
        currency: CURRENCY,
        wagerThreshold: '1000',
        rakebackPercent: '8',
      },
    ])
    .returning({ id: promoRankTier.id, key: promoRankTier.key });
  const idOf = (key: string) => {
    const tier = tiers.find((row) => row.key === key);
    if (!tier) {
      throw new Error(`tier ${key} missing`);
    }
    return tier.id;
  };
  bronzeId = idOf('bronze');
  silverId = idOf('silver');
  await db.drizzle.db.insert(promoRankConfig).values({
    eligibleProducts: ['sportsbook', 'casino'],
    rakebackEligibleProducts: ['sportsbook', 'casino'],
  });
  await db.drizzle.db.insert(promoStreakConfig).values({
    enabled: true,
    dailyMinWager: '1',
    eligibleProducts: ['sportsbook'],
    rakebackMilestones: [{ day: 1, unrankedRatePercent: '2', rankedUpliftPercent: '0' }],
  });
}, 120_000);

afterAll(() => db.drop());

describe('rakeback accrual and payout', () => {
  it('a settled bet accrues rakeback at the ranked rate for a ranked player', async () => {
    const bronze = await rankedPlayer(bronzeId);
    const silver = await rankedPlayer(silverId);
    const service = claimMode();

    await inTx((tx) => service.recordSettledWager(tx, settledArgs(bronze, '10')));
    await inTx((tx) => service.recordSettledWager(tx, settledArgs(silver, '10')));

    expect(await accrualsOf(bronze)).toEqual([
      expect.objectContaining({ amount: '0.500000000000000000', stake: '10.000000000000000000' }),
    ]);
    expect(await accrualsOf(silver)).toEqual([
      expect.objectContaining({ amount: '0.800000000000000000', stake: '10.000000000000000000' }),
    ]);
  });

  it('a settled bet accrues rakeback at the unranked rate for an unranked player', async () => {
    const id = randomUUID();
    await db.drizzle.db
      .insert(promoPlayerStreak)
      .values({ userId: id, current: 1, best: 1, lastQualifyingDay: isoDate(new Date()) });
    const service = claimMode();

    await inTx((tx) => service.recordSettledWager(tx, settledArgs(id, '10')));

    expect(await accrualsOf(id)).toEqual([
      expect.objectContaining({
        amount: '0.008000000000000000',
        basis: 'margin',
        status: 'accrued',
      }),
    ]);
  });

  it('a player with no rank and no live streak accrues nothing', async () => {
    const id = randomUUID();
    const service = claimMode();

    await inTx((tx) => service.recordSettledWager(tx, settledArgs(id, '10')));

    expect(await accrualsOf(id)).toEqual([]);
  });

  it('a claimable accrual stays open until claimed and a settled round counts once', async () => {
    const id = await rankedPlayer(bronzeId);
    const service = claimMode();
    const args = settledArgs(id, '10');

    await inTx((tx) => service.recordSettledWager(tx, args));
    await inTx((tx) => service.recordSettledWager(tx, args));

    const rows = await accrualsOf(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'accrued', claimId: null, settledAt: null });
  });

  it('a round reversal removes the accrual it created and a repeated reversal does nothing', async () => {
    const id = await rankedPlayer(bronzeId);
    const service = claimMode();
    const roundId = randomUUID();
    const casino = contextOf({ product: 'casino' });
    await inTx((tx) => service.recordWager(tx, argsFor(id, '10', roundId, casino)));
    const reversal = {
      userId: id,
      currency: CURRENCY,
      round: { providerName: PROVIDER, externalRoundId: roundId },
      realAmount: '4',
    };

    await inTx((tx) => service.reverseWager(tx, reversal));
    const partial = await accrualsOf(id);
    await inTx((tx) => service.reverseWager(tx, { ...reversal, realAmount: '6' }));
    await inTx((tx) => service.reverseWager(tx, { ...reversal, realAmount: '6' }));

    expect(partial).toEqual([
      expect.objectContaining({
        status: 'accrued',
        amount: '0.300000000000000000',
        stake: '6.000000000000000000',
      }),
    ]);
    expect(await accrualsOf(id)).toEqual([expect.objectContaining({ status: 'reversed' })]);
  });

  it('an accrual in a currency with no rate stays accrued and counts nothing toward the reference total', async () => {
    const id = await rankedPlayer(bronzeId);
    const service = claimMode();
    const noRates: ExchangeRateReader = {
      getRate: async () => null,
      convert: async () => null,
    };

    await inTx((tx) =>
      service.recordSettledWager(tx, { ...settledArgs(id, '10'), currency: 'EUR' }),
    );
    const totals = await unclaimedRakeback(db.drizzle.db, noRates, CURRENCY, id);

    expect(totals).toEqual({
      unclaimed: [{ currency: 'EUR', amount: '0.500000000000000000', referenceAmount: null }],
      referenceCurrency: CURRENCY,
      referenceTotal: '0',
    });
    expect(await accrualsOf(id)).toEqual([
      expect.objectContaining({ currency: 'EUR', status: 'accrued', claimId: null }),
    ]);
  });
});

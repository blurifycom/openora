import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { mock } from '../../../testing/mock.js';
import type { WagerContext, WalletCommands, WalletCreditArgs } from '@openora/core/contracts';
import { migrate } from '../migrate.js';
import {
  promoPlayerRank,
  promoRakebackAccrual,
  promoRakebackClaim,
  promoRankConfig,
  promoRankLevelUp,
  promoRankPeriodWager,
  promoRankTier,
} from '../schema/index.js';
import { DEFAULT_PAYOUT_ANCHORS } from '../contract/index.js';
import { seedRankLadder } from '../seed/index.js';
import { RakebackService, type RakebackSettings } from '../service/rakeback.service.js';

let db: TestDb;
const logger = { warn: vi.fn() };
const credit = vi.fn<WalletCommands['credit']>();
let rakeback: RakebackService;

const CASINO: WagerContext = { provider: 'aggregator', product: 'casino' };
const LADDER = {
  currency: 'USDT',
  tiers: [
    { key: 'bronze', name: 'Bronze', wagerThreshold: '0', rakebackPercent: '1' },
    { key: 'silver', name: 'Silver', wagerThreshold: '10000', rakebackPercent: '3' },
    { key: 'gold', name: 'Gold', wagerThreshold: '50000', rakebackPercent: '5' },
  ],
  config: {
    eligibleProducts: [],
    rewards: {},
    payoutAnchors: DEFAULT_PAYOUT_ANCHORS,
    payInPlayerCurrency: false,
    periodicRequiresActivity: true,
  },
};

const wager = (userId: string, amount: string, realAmount: string = amount) =>
  db.drizzle.db.transaction((tx) =>
    rakeback.recordWager(tx, {
      userId,
      currency: 'USDT',
      amount,
      weightedAmount: amount,
      realAmount,
      context: CASINO,
    }),
  );

const serviceWith = (settings: RakebackSettings) =>
  new RakebackService(() => mock<WalletCommands>({ credit }), logger, settings);

const betOn = (
  service: RakebackService,
  userId: string,
  amount: string,
  options: { rtp?: string; roundId?: string } = {},
) =>
  db.drizzle.db.transaction((tx) =>
    service.recordWager(tx, {
      userId,
      currency: 'USDT',
      amount,
      weightedAmount: amount,
      realAmount: amount,
      context: { ...CASINO, rtp: options.rtp, gameId: 'game-1' },
      round: options.roundId
        ? { providerName: 'aggregator', externalRoundId: options.roundId }
        : undefined,
    }),
  );

const rollBack = (service: RakebackService, userId: string, roundId: string, realAmount: string) =>
  db.drizzle.db.transaction((tx) =>
    service.reverseWager(tx, {
      userId,
      currency: 'USDT',
      round: { providerName: 'aggregator', externalRoundId: roundId },
      realAmount,
    }),
  );

const accrualsOf = (userId: string) =>
  db.drizzle.db
    .select()
    .from(promoRakebackAccrual)
    .where(eq(promoRakebackAccrual.userId, userId))
    .orderBy(promoRakebackAccrual.createdAt);

const givePlayerTier = async (userId: string, tierKey: string) => {
  const [tier] = await db.drizzle.db
    .select({ id: promoRankTier.id })
    .from(promoRankTier)
    .where(eq(promoRankTier.key, tierKey));
  await db.drizzle.db
    .insert(promoPlayerRank)
    .values({ userId, currency: 'USDT', tierId: tier?.id })
    .onConflictDoUpdate({ target: promoPlayerRank.userId, set: { tierId: tier?.id } });
};

beforeAll(async () => {
  db = await createTestDb([migrate]);
  rakeback = new RakebackService(() => mock<WalletCommands>({ credit }), logger);
});

afterAll(() => db.drop());

beforeEach(async () => {
  vi.clearAllMocks();
  credit.mockResolvedValue({ ok: true, moved: true, transactionId: randomUUID(), newBalance: '0' });
  await db.drizzle.db.delete(promoRakebackAccrual);
  await db.drizzle.db.delete(promoRakebackClaim);
  await db.drizzle.db.delete(promoRankLevelUp);
  await db.drizzle.db.delete(promoRankPeriodWager);
  await db.drizzle.db.delete(promoPlayerRank);
  await db.drizzle.db.delete(promoRankTier);
  await db.drizzle.db.delete(promoRankConfig);
  await seedRankLadder(db.drizzle.db, LADDER);
});

describe('instant rakeback on a qualifying bet', () => {
  it('credits real balance at the tier rakeback percentage, off the own-money stake only', async () => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'bronze');

    // Staked 100, but only 60 of it was the player's own money - the rest was bonus-funded.
    await wager(userId, '100', '60');

    expect(credit).toHaveBeenCalledTimes(1);
    const args = credit.mock.calls[0]?.[1] as WalletCreditArgs;
    expect(args).toMatchObject({
      userId,
      currency: 'USDT',
      amount: '0.600000000000000000',
      type: 'cashback',
    });
  });

  it('adds an active streak boost on top of the tier rate', async () => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'bronze');
    await db.drizzle.db
      .update(promoPlayerRank)
      .set({ rakebackBoostPercent: '2', rakebackBoostExpiresAt: new Date(Date.now() + 86_400_000) })
      .where(eq(promoPlayerRank.userId, userId));

    await wager(userId, '100');

    const args = credit.mock.calls[0]?.[1] as WalletCreditArgs;
    // bronze 1% + boost 2% = 3% of 100
    expect(args.amount).toBe('3.000000000000000000');
  });

  it('ignores an expired streak boost', async () => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'bronze');
    await db.drizzle.db
      .update(promoPlayerRank)
      .set({ rakebackBoostPercent: '2', rakebackBoostExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(promoPlayerRank.userId, userId));

    await wager(userId, '100');

    const args = credit.mock.calls[0]?.[1] as WalletCreditArgs;
    expect(args.amount).toBe('1.000000000000000000');
  });

  it('pays nothing for a bet fully funded by bonus money', async () => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'bronze');

    await wager(userId, '100', '0');

    expect(credit).not.toHaveBeenCalled();
  });

  it('pays nothing for a player who has not been assigned a rank yet', async () => {
    const userId = randomUUID();

    await wager(userId, '100');

    expect(credit).not.toHaveBeenCalled();
  });

  it('reports the credit for the caller to announce once its own transaction commits', async () => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'bronze');
    const transactionId = randomUUID();
    credit.mockResolvedValue({ ok: true, moved: true, transactionId, newBalance: '1' });

    const credits = await wager(userId, '100');

    expect(credits).toEqual([{ transactionId, amount: '1.000000000000000000', currency: 'USDT' }]);
  });

  it('reports nothing for a replayed credit that moved no money', async () => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'bronze');
    credit.mockResolvedValue({ ok: true, moved: false, newBalance: '1' });

    const credits = await wager(userId, '100');

    expect(credits).toEqual([]);
  });

  it('reports nothing when the wallet refuses the credit', async () => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'bronze');
    credit.mockResolvedValue({ ok: false, reason: 'wallet not found' });

    const credits = await wager(userId, '100');

    expect(credits).toEqual([]);
  });
});

describe('rakeback on the house edge', () => {
  const margin = () => serviceWith({ basis: 'margin', payout: 'instant' });

  it('pays the tier rate on the stake times one minus the rtp', async () => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'gold');

    await betOn(margin(), userId, '100', { rtp: '0.96' });

    expect(credit.mock.calls[0]?.[1]).toMatchObject({ amount: '0.200000000000000000' });
  });

  it('pays a bottom-tier player 0.01 per 100 staked on a 99% game', async () => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'bronze');

    await betOn(margin(), userId, '100', { rtp: '0.99' });

    expect(credit.mock.calls[0]?.[1]).toMatchObject({ amount: '0.010000000000000000' });
  });

  it('adds an active streak boost to the tier rate before applying the edge', async () => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'gold');
    await db.drizzle.db
      .update(promoPlayerRank)
      .set({ rakebackBoostPercent: '1', rakebackBoostExpiresAt: new Date(Date.now() + 86_400_000) })
      .where(eq(promoPlayerRank.userId, userId));

    await betOn(margin(), userId, '100', { rtp: '0.96' });

    expect(credit.mock.calls[0]?.[1]).toMatchObject({ amount: '0.240000000000000000' });
  });

  it.each([
    ['missing', undefined],
    ['out of range', '1.2'],
    ['a percent', '96'],
    ['one', '1'],
  ])('pays nothing when the rtp is %s', async (_label, rtp) => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'gold');

    const credits = await betOn(margin(), userId, '100', { rtp });

    expect(credits).toEqual([]);
    expect(credit).not.toHaveBeenCalled();
  });
});

describe('claimable rakeback accrual', () => {
  const claimable = () => serviceWith({ basis: 'margin', payout: 'claim' });

  it('writes an unclaimed accrual and moves no money', async () => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'gold');

    const credits = await betOn(claimable(), userId, '100', { rtp: '0.96', roundId: 'r-1' });

    expect(credits).toEqual([]);
    expect(credit).not.toHaveBeenCalled();
    expect(await accrualsOf(userId)).toEqual([
      expect.objectContaining({
        currency: 'USDT',
        amount: '0.200000000000000000',
        stake: '100.000000000000000000',
        basis: 'margin',
        rtp: '0.960000000000000000',
        ratePercent: '5.00',
        boostPercent: '0.00',
        gameId: 'game-1',
        providerName: 'aggregator',
        externalRoundId: 'r-1',
        status: 'accrued',
        claimId: null,
      }),
    ]);
  });

  it('keeps no rtp on a stake-basis accrual', async () => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'bronze');

    await betOn(serviceWith({ basis: 'stake', payout: 'claim' }), userId, '100', { rtp: '0.96' });

    expect(await accrualsOf(userId)).toEqual([
      expect.objectContaining({ amount: '1.000000000000000000', basis: 'stake', rtp: null }),
    ]);
  });

  it('writes nothing for a bet that earns nothing', async () => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'gold');

    await betOn(claimable(), userId, '100', { rtp: '1' });

    expect(await accrualsOf(userId)).toEqual([]);
  });
});

describe('a rollback of a round with claimable rakeback', () => {
  const claimable = () => serviceWith({ basis: 'margin', payout: 'claim' });

  const markClaimed = async (accrualId: string, userId: string) => {
    const [claim] = await db.drizzle.db
      .insert(promoRakebackClaim)
      .values({ userId, idempotencyKey: randomUUID(), outcome: 'claimed' })
      .returning();
    await db.drizzle.db
      .update(promoRakebackAccrual)
      .set({ status: 'claimed', claimId: claim?.id, settledAt: new Date() })
      .where(eq(promoRakebackAccrual.id, accrualId));
  };

  it('reverses an unclaimed accrual in full', async () => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'gold');
    await betOn(claimable(), userId, '100', { rtp: '0.96', roundId: 'r-1' });

    await rollBack(claimable(), userId, 'r-1', '100');

    expect(await accrualsOf(userId)).toEqual([
      expect.objectContaining({ status: 'reversed', amount: '0.200000000000000000' }),
    ]);
  });

  it('reduces an unclaimed accrual in proportion to a partial rollback', async () => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'gold');
    await betOn(claimable(), userId, '100', { rtp: '0.96', roundId: 'r-1' });

    await rollBack(claimable(), userId, 'r-1', '25');

    expect(await accrualsOf(userId)).toEqual([
      expect.objectContaining({
        status: 'accrued',
        stake: '75.000000000000000000',
        amount: '0.150000000000000000',
      }),
    ]);
  });

  it('keeps the stake and amount a claimed accrual was paid on', async () => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'gold');
    await betOn(claimable(), userId, '100', { rtp: '0.96', roundId: 'r-1' });
    const [row] = await accrualsOf(userId);
    await markClaimed(row!.id, userId);

    await rollBack(claimable(), userId, 'r-1', '100');

    expect(await accrualsOf(userId)).toEqual([
      expect.objectContaining({
        status: 'claimed',
        amount: '0.200000000000000000',
        stake: '100.000000000000000000',
        rolledBackStake: '100.000000000000000000',
      }),
    ]);
  });

  it('lets a claimed newer bet absorb the rollback before it reaches an older unclaimed one', async () => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'gold');
    await betOn(claimable(), userId, '100', { rtp: '0.96', roundId: 'r-1' });
    await betOn(claimable(), userId, '50', { rtp: '0.96', roundId: 'r-1' });
    const [older, newer] = await accrualsOf(userId);
    await markClaimed(newer!.id, userId);

    await rollBack(claimable(), userId, 'r-1', '70');

    const after = await accrualsOf(userId);
    expect(after.find((row) => row.id === newer!.id)).toMatchObject({ status: 'claimed' });
    expect(after.find((row) => row.id === older!.id)).toMatchObject({
      status: 'accrued',
      stake: '80.000000000000000000',
      amount: '0.160000000000000000',
    });
  });

  it('lets a claimed bet absorb its stake only once across repeated rollbacks', async () => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'gold');
    await betOn(claimable(), userId, '100', { rtp: '0.96', roundId: 'r-1' });
    await betOn(claimable(), userId, '50', { rtp: '0.96', roundId: 'r-1' });
    const [older, newer] = await accrualsOf(userId);
    await markClaimed(newer!.id, userId);

    await rollBack(claimable(), userId, 'r-1', '70');
    await rollBack(claimable(), userId, 'r-1', '80');

    const after = await accrualsOf(userId);
    expect(after.find((row) => row.id === newer!.id)).toMatchObject({
      status: 'claimed',
      amount: '0.100000000000000000',
      rolledBackStake: '50.000000000000000000',
    });
    expect(after.find((row) => row.id === older!.id)).toMatchObject({ status: 'reversed' });
  });

  it('lets a voided bet absorb its own rollback without reaching an older unclaimed one', async () => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'gold');
    await betOn(claimable(), userId, '100', { rtp: '0.96', roundId: 'r-1' });
    await betOn(claimable(), userId, '50', { rtp: '0.96', roundId: 'r-1' });
    const [older, newer] = await accrualsOf(userId);
    await db.drizzle.db
      .update(promoRakebackAccrual)
      .set({ status: 'voided', voidReason: 'duplicate bet', settledAt: new Date() })
      .where(eq(promoRakebackAccrual.id, newer!.id));

    await rollBack(claimable(), userId, 'r-1', '50');

    expect(await accrualsOf(userId)).toEqual([
      expect.objectContaining({
        id: older!.id,
        status: 'accrued',
        stake: '100.000000000000000000',
        amount: '0.200000000000000000',
      }),
      expect.objectContaining({
        id: newer!.id,
        status: 'voided',
        stake: '50.000000000000000000',
        rolledBackStake: '50.000000000000000000',
      }),
    ]);
  });

  it('never touches another round', async () => {
    const userId = randomUUID();
    await givePlayerTier(userId, 'gold');
    await betOn(claimable(), userId, '100', { rtp: '0.96', roundId: 'r-1' });

    await rollBack(claimable(), userId, 'r-2', '100');

    expect(await accrualsOf(userId)).toEqual([expect.objectContaining({ status: 'accrued' })]);
  });
});

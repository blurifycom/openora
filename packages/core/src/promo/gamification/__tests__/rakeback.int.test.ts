import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { mock } from '../../../testing/mock.js';
import type { WagerContext, WalletCommands, WalletCreditArgs } from '@openora/core/contracts';
import { migrate } from '../migrate.js';
import {
  promoPlayerRank,
  promoRankConfig,
  promoRankLevelUp,
  promoRankPeriodWager,
  promoRankTier,
} from '../schema/index.js';
import { DEFAULT_PAYOUT_ANCHORS } from '../contract/index.js';
import { seedRankLadder } from '../seed/index.js';
import { RakebackService } from '../service/rakeback.service.js';

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

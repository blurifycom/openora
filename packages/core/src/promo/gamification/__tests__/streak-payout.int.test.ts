import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { mock } from '../../../testing/mock.js';
import type {
  BonusGrantCommands,
  ExchangeRateReader,
  PlayEligibilityPort,
  WalletCommands,
} from '@openora/core/contracts';
import { migrate } from '../migrate.js';
import { promoStreakConfig, promoStreakMilestoneGrant } from '../schema/index.js';
import {
  StreakMilestoneNotClaimableError,
  StreakPayoutService,
} from '../service/streak-payout.service.js';
import type { StreakMilestone } from '../contract/index.js';

let db: TestDb;
const grant = vi.fn<BonusGrantCommands['grant']>();
const isRestricted = vi.fn<PlayEligibilityPort['isRestricted']>();
const credit = vi.fn<WalletCommands['credit']>();
const convert = vi.fn<ExchangeRateReader['convert']>();

const MILESTONES: StreakMilestone[] = [
  { day: 3, rewards: [{ kind: 'cash', amount: '5' }] },
  {
    day: 7,
    rewards: [
      {
        kind: 'bonus',
        amount: '10',
        terms: { wageringMultiplier: '5', expiryDays: 30, maxBet: '2' },
      },
    ],
  },
];

// The streak's own currency and the payout currency match by default, so most tests exercise
// the no-conversion path - the currency-conversion behaviour has its own describe blocks below.
const service = (payoutCurrency = 'USD') =>
  new StreakPayoutService(
    db.drizzle,
    mock<BonusGrantCommands>({ grant }),
    mock<PlayEligibilityPort>({ isRestricted }),
    mock<ExchangeRateReader>({ convert }),
    payoutCurrency,
    mock<WalletCommands>({ credit }),
  );

const owe = async (userId: string, day: number) => {
  const [row] = await db.drizzle.db
    .insert(promoStreakMilestoneGrant)
    .values({ userId, day })
    .returning({ id: promoStreakMilestoneGrant.id });
  return row?.id ?? '';
};

const milestoneGrant = async (id: string) => {
  const [row] = await db.drizzle.db
    .select({
      settledAt: promoStreakMilestoneGrant.settledAt,
      outcome: promoStreakMilestoneGrant.outcome,
      announcedAt: promoStreakMilestoneGrant.announcedAt,
    })
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
  isRestricted.mockResolvedValue(false);
  credit.mockResolvedValue({ ok: true, moved: true, transactionId: randomUUID(), newBalance: '5' });
  grant.mockImplementation(async () => ({ ok: true, created: true, grantId: randomUUID() }));
  await db.drizzle.db.delete(promoStreakMilestoneGrant);
  await db.drizzle.db.delete(promoStreakConfig);
  await db.drizzle.db.insert(promoStreakConfig).values({
    currency: 'USD',
    dailyMinWager: '1',
    eligibleProducts: [],
    milestones: MILESTONES,
    resetAfterDay: 30,
  });
});

describe('claiming a streak reward', () => {
  it('credits a cash reward to the real balance, with no bonus grant, and settles the milestone', async () => {
    const userId = randomUUID();
    const id = await owe(userId, 3);

    const claimed = await service().claim(userId, id);

    expect(claimed.outcome).toBe('granted');
    expect(grant).not.toHaveBeenCalled();
    expect(credit).toHaveBeenCalledTimes(1);
    expect(credit.mock.calls[0]?.[1]).toMatchObject({
      userId,
      amount: '5',
      currency: 'USD',
      type: 'cashback',
      providerRef: { providerName: 'promo-streak', providerRefId: `streak-milestone:${id}:0` },
    });
    await expect(milestoneGrant(id)).resolves.toMatchObject({ outcome: 'granted' });
  });

  it('pays once: a second claim of the same milestone is refused and credits nothing', async () => {
    const userId = randomUUID();
    const id = await owe(userId, 3);

    await service().claim(userId, id);

    await expect(service().claim(userId, id)).rejects.toBeInstanceOf(
      StreakMilestoneNotClaimableError,
    );
    expect(credit).toHaveBeenCalledTimes(1);
  });

  it('pays once when two claims race', async () => {
    const userId = randomUUID();
    const id = await owe(userId, 3);

    const results = await Promise.allSettled([
      service().claim(userId, id),
      service().claim(userId, id),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(credit).toHaveBeenCalledTimes(1);
  });

  it("refuses a claim of another player's milestone and leaves it waiting for its owner", async () => {
    const owner = randomUUID();
    const id = await owe(owner, 3);

    await expect(service().claim(randomUUID(), id)).rejects.toBeInstanceOf(
      StreakMilestoneNotClaimableError,
    );

    expect(credit).not.toHaveBeenCalled();
    await expect(milestoneGrant(id)).resolves.toMatchObject({ settledAt: null });
  });

  it('gives nothing to a player under a responsible-gambling restriction', async () => {
    isRestricted.mockResolvedValue(true);
    const userId = randomUUID();
    const id = await owe(userId, 3);

    const claimed = await service().claim(userId, id);

    expect(claimed.outcome).toBe('restricted');
    expect(credit).not.toHaveBeenCalled();
    await expect(milestoneGrant(id)).resolves.toMatchObject({ outcome: 'restricted' });
  });

  it('leaves the milestone waiting, granting nothing, when the wallet credit fails', async () => {
    const userId = randomUUID();
    const id = await owe(userId, 3);
    credit.mockResolvedValue({ ok: false, reason: 'wallet not found' });

    await expect(service().claim(userId, id)).rejects.toThrow(/wallet not found/);

    await expect(milestoneGrant(id)).resolves.toMatchObject({ settledAt: null });
  });
});

describe('crediting a cash reward in a currency the player can actually hold', () => {
  it('converts the reward into the payout currency before crediting', async () => {
    const userId = randomUUID();
    const id = await owe(userId, 3);
    convert.mockResolvedValue('4.5');

    const { cashPaid } = await service('USDT').claim(userId, id);

    expect(convert).toHaveBeenCalledWith('5', 'USD', 'USDT', expect.anything());
    expect(credit.mock.calls[0]?.[1]).toMatchObject({ amount: '4.5', currency: 'USDT' });
    expect(cashPaid).toEqual([
      expect.objectContaining({ userId, amount: '4.5', currency: 'USDT' }),
    ]);
  });

  it('leaves the milestone waiting when no rate is available, so the claim can be retried', async () => {
    const userId = randomUUID();
    const id = await owe(userId, 3);
    convert.mockResolvedValue(null);

    await expect(service('USDT').claim(userId, id)).rejects.toThrow(/no exchange rate/);

    expect(credit).not.toHaveBeenCalled();
    await expect(milestoneGrant(id)).resolves.toMatchObject({ settledAt: null });
  });
});

describe('announcing a reward waiting to be claimed', () => {
  it('announces each unclaimed milestone once', async () => {
    const userId = randomUUID();
    const id = await owe(userId, 3);

    const first = await service().announceReached();
    const second = await service().announceReached();

    expect(first).toEqual([{ userId, day: 3, grantId: null }]);
    expect(second).toEqual([]);
    expect((await milestoneGrant(id))?.announcedAt).toBeInstanceOf(Date);
  });

  it('does not announce a milestone already claimed', async () => {
    const userId = randomUUID();
    const id = await owe(userId, 3);
    await service().claim(userId, id);

    await expect(service().announceReached()).resolves.toEqual([]);
  });
});

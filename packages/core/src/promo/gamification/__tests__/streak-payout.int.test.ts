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
import { StreakPayoutService } from '../service/streak-payout.service.js';
import type { StreakMilestone } from '../contract/index.js';

let db: TestDb;
const grant = vi.fn<BonusGrantCommands['grant']>();
const isRestricted = vi.fn<PlayEligibilityPort['isRestricted']>();
const credit = vi.fn<WalletCommands['credit']>();
const convert = vi.fn<ExchangeRateReader['convert']>();
const logger = { warn: vi.fn(), error: vi.fn() };

const MILESTONES: StreakMilestone[] = [{ day: 3, rewards: [{ kind: 'cash', amount: '5' }] }];

// The streak's own currency and the payout currency match by default, so most tests exercise
// the no-conversion path - the currency-conversion behaviour has its own describe block below.
const service = (payoutCurrency = 'USD') =>
  new StreakPayoutService(
    db.drizzle,
    mock<BonusGrantCommands>({ grant }),
    mock<PlayEligibilityPort>({ isRestricted }),
    mock<ExchangeRateReader>({ convert }),
    payoutCurrency,
    logger,
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

describe('settling a cash streak reward', () => {
  it('credits real balance directly, with no bonus grant', async () => {
    const userId = randomUUID();
    const id = await owe(userId, 3);

    await service().settlePending();

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

  it('is idempotent: a retried settlement does not credit twice', async () => {
    const userId = randomUUID();
    const id = await owe(userId, 3);

    await service().settlePending();
    // Re-open the row as unsettled, as a retry after a partial failure would find it.
    await db.drizzle.db
      .update(promoStreakMilestoneGrant)
      .set({ settledAt: null, outcome: null })
      .where(eq(promoStreakMilestoneGrant.id, id));
    credit.mockResolvedValueOnce({ ok: true, moved: false, newBalance: '5' });
    await service().settlePending();

    expect(credit).toHaveBeenCalledTimes(2);
    // Both calls carry the same providerRefId, so the wallet's own idempotency guard is what
    // stops the second call from moving money twice - `moved: false` on the second is that guard.
    expect(credit.mock.calls[1]?.[1]).toMatchObject({
      providerRef: { providerRefId: `streak-milestone:${id}:0` },
    });
  });

  it('gives nothing to a player under a responsible-gambling restriction', async () => {
    isRestricted.mockResolvedValue(true);
    const userId = randomUUID();
    const id = await owe(userId, 3);

    await service().settlePending();

    expect(credit).not.toHaveBeenCalled();
    await expect(milestoneGrant(id)).resolves.toMatchObject({ outcome: 'restricted' });
  });
});

describe('crediting a cash reward in a currency the player can actually hold', () => {
  it('converts the reward into the payout currency before crediting', async () => {
    const userId = randomUUID();
    await owe(userId, 3);
    convert.mockResolvedValue('4.5');

    const { cashPaid } = await service('USDT').settlePending();

    expect(convert).toHaveBeenCalledWith('5', 'USD', 'USDT');
    expect(credit.mock.calls[0]?.[1]).toMatchObject({ amount: '4.5', currency: 'USDT' });
    expect(cashPaid).toEqual([
      expect.objectContaining({ userId, amount: '4.5', currency: 'USDT' }),
    ]);
  });

  it('leaves the milestone unsettled to retry when no rate is available', async () => {
    const userId = randomUUID();
    const id = await owe(userId, 3);
    convert.mockResolvedValue(null);

    const { cashPaid } = await service('USDT').settlePending();

    expect(cashPaid).toEqual([]);
    expect(credit).not.toHaveBeenCalled();
    await expect(milestoneGrant(id)).resolves.toMatchObject({ settledAt: null });
  });

  it('leaves the milestone unsettled, granting nothing, when the wallet credit fails', async () => {
    const userId = randomUUID();
    const id = await owe(userId, 3);
    credit.mockResolvedValue({ ok: false, reason: 'wallet not found' });

    const { cashPaid } = await service().settlePending();

    expect(cashPaid).toEqual([]);
    await expect(milestoneGrant(id)).resolves.toMatchObject({ settledAt: null });
  });
});

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { mock } from '../../../testing/mock.js';
import type {
  BonusGrantCommands,
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
const logger = { warn: vi.fn(), error: vi.fn() };

const MILESTONES: StreakMilestone[] = [{ day: 3, rewards: [{ kind: 'cash', amount: '5' }] }];

const service = () =>
  new StreakPayoutService(
    db.drizzle,
    mock<BonusGrantCommands>({ grant }),
    mock<PlayEligibilityPort>({ isRestricted }),
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

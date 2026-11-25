import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createTestDb, seedPlayerWithUser, type TestDb } from '@openora/core/testing';
import { mock } from '../../../testing/mock.js';
import type {
  AuditWritePort,
  PlayEligibilityPort,
  RgExclusionReader,
  WalletCommands,
  WalletCreditArgs,
} from '@openora/core/contracts';
import type { EventBus } from '@openora/core/server';
import { user } from '@openora/core/pam/schema/identity';
import { migrate } from '../migrate.js';
import { migrate as identityMigrate } from '@openora/core/pam/migrate/identity';
import { migrate as profileMigrate } from '@openora/core/pam/migrate/profile';
import { promoRankPeriodicReward } from '../schema/index.js';
import {
  RankRewardAccountBlockedError,
  RankRewardAlreadyClaimedError,
  RankRewardClaimRestrictedError,
  RankRewardClaimService,
  RankRewardIdempotencyKeyReusedError,
  RankRewardNotFoundError,
} from '../service/rank-reward-claim.service.js';
import { identityOver, ledgerEligibilityOver } from './ledger-eligibility-shim.js';

let db: TestDb;
const credit = vi.fn<WalletCommands['credit']>();
const isRestricted = vi.fn<PlayEligibilityPort['isRestricted']>();
const getExclusionState = vi.fn<RgExclusionReader['getExclusionState']>();
const recordInTransaction = vi.fn<AuditWritePort['recordInTransaction']>();
const emitInTransaction = vi.fn<EventBus['emitInTransaction']>();

const claims = () =>
  new RankRewardClaimService({
    drizzle: db.drizzle,
    wallet: mock<WalletCommands>({ credit }),
    eligibility: ledgerEligibilityOver(db.drizzle, isRestricted),
    exclusions: mock<RgExclusionReader>({ getExclusionState }),
    audit: mock<AuditWritePort>({ recordInTransaction }),
    events: mock<EventBus>({ emitInTransaction }),
    logger: { info: vi.fn() },
    identity: identityOver(db.drizzle),
  });

const newPlayer = async (status: 'active' | 'self_excluded' | 'suspended' | 'closed' = 'active') =>
  (await seedPlayerWithUser(db, { status })).account.id;

let periods = 0;
const leave = async (userId: string, amount = '2', currency = 'USDT') => {
  periods += 1;
  const [row] = await db.drizzle.db
    .insert(promoRankPeriodicReward)
    .values({
      userId,
      kind: 'daily',
      periodKey: `rank-daily:2026-09-${String(periods).padStart(2, '0')}T00`,
      periodStart: new Date('2026-09-21T00:00:00Z'),
      periodEnd: new Date('2026-09-22T00:00:00Z'),
      tierId: randomUUID(),
      ladderCurrency: 'USD',
      ladderAmount: amount,
      currency,
      amount,
    })
    .returning();
  return row!;
};

const rewardRow = async (id: string) =>
  (
    await db.drizzle.db
      .select()
      .from(promoRankPeriodicReward)
      .where(eq(promoRankPeriodicReward.id, id))
  )[0];

const creditedArgs = () => credit.mock.calls.map((call) => call[1] as WalletCreditArgs);
const emitted = (topic: string) =>
  emitInTransaction.mock.calls.filter((call) => call[1] === topic).map((call) => call[2]);

beforeAll(async () => {
  db = await createTestDb([migrate, identityMigrate, profileMigrate]);
});

afterAll(() => db.drop());

beforeEach(async () => {
  vi.clearAllMocks();
  credit.mockImplementation(async () => ({
    ok: true,
    moved: true,
    transactionId: randomUUID(),
    newBalance: '0',
  }));
  isRestricted.mockResolvedValue(false);
  getExclusionState.mockResolvedValue({ isSelfExcluded: false, isCoolingOff: false });
  await db.drizzle.db.delete(promoRankPeriodicReward);
});

describe('a player claiming a rank reward', () => {
  it('pays it to the real balance as cashback, settles the row, audits and announces it', async () => {
    const userId = await newPlayer();
    const reward = await leave(userId, '2.5');

    const result = await claims().claim(userId, reward.id, randomUUID());

    expect(result).toEqual({
      rewardId: reward.id,
      kind: 'daily',
      currency: 'USDT',
      amount: '2.500000000000000000',
    });
    expect(creditedArgs()).toEqual([
      expect.objectContaining({
        userId,
        currency: 'USDT',
        amount: '2.500000000000000000',
        type: 'cashback',
        providerRef: expect.objectContaining({
          providerName: 'rank-periodic-reward',
          providerRefId: reward.id,
        }),
      }),
    ]);
    const row = await rewardRow(reward.id);
    expect(row).toMatchObject({ status: 'claimed', transactionId: expect.any(String) });
    expect(row?.settledAt).toBeInstanceOf(Date);
    const tx = credit.mock.calls[0]![0];
    expect(recordInTransaction).toHaveBeenCalledExactlyOnceWith(
      tx,
      expect.objectContaining({
        actorId: userId,
        actorType: 'player',
        action: 'promo.rank_reward.claimed',
        resourceType: 'promo_rank_periodic_reward',
        resourceId: reward.id,
      }),
    );
    expect(emitted('promo.rank.reward.claimed')).toEqual([
      {
        userId,
        rewardId: reward.id,
        kind: 'daily',
        currency: 'USDT',
        amount: '2.500000000000000000',
        transactionId: row?.transactionId,
        outcome: 'claimed',
      },
    ]);
    expect(emitted('wallet.balance.changed')).toHaveLength(1);
  });

  it('pays only the reward named, leaving the others claimable', async () => {
    const userId = await newPlayer();
    const first = await leave(userId);
    const second = await leave(userId);

    await claims().claim(userId, first.id, randomUUID());

    expect((await rewardRow(second.id))?.status).toBe('claimable');
  });

  it('returns the first result for a retry with the same key and pays nothing more', async () => {
    const userId = await newPlayer();
    const reward = await leave(userId);
    const key = randomUUID();
    const first = await claims().claim(userId, reward.id, key);

    const retry = await claims().claim(userId, reward.id, key);

    expect(retry).toEqual(first);
    expect(credit).toHaveBeenCalledTimes(1);
  });

  it('refuses a key that already claimed another reward', async () => {
    const userId = await newPlayer();
    const first = await leave(userId);
    const second = await leave(userId);
    const key = randomUUID();
    await claims().claim(userId, first.id, key);

    await expect(claims().claim(userId, second.id, key)).rejects.toBeInstanceOf(
      RankRewardIdempotencyKeyReusedError,
    );
    expect((await rewardRow(second.id))?.status).toBe('claimable');
  });

  it('refuses a reward already paid under another key', async () => {
    const userId = await newPlayer();
    const reward = await leave(userId);
    await claims().claim(userId, reward.id, randomUUID());

    await expect(claims().claim(userId, reward.id, randomUUID())).rejects.toBeInstanceOf(
      RankRewardAlreadyClaimedError,
    );
    expect(credit).toHaveBeenCalledTimes(1);
  });

  it('pays once when two claims with different keys race', async () => {
    const userId = await newPlayer();
    const reward = await leave(userId);

    const results = await Promise.allSettled([
      claims().claim(userId, reward.id, randomUUID()),
      claims().claim(userId, reward.id, randomUUID()),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.filter((r) => r.status === 'rejected');
    expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(RankRewardAlreadyClaimedError);
    expect(credit).toHaveBeenCalledTimes(1);
  });

  it('pays once when the same key is sent twice at the same moment', async () => {
    const userId = await newPlayer();
    const reward = await leave(userId);
    const key = randomUUID();

    const [a, b] = await Promise.all([
      claims().claim(userId, reward.id, key),
      claims().claim(userId, reward.id, key),
    ]);

    expect(a).toEqual(b);
    expect(credit).toHaveBeenCalledTimes(1);
  });

  it("does not find another player's reward, or an unknown one", async () => {
    const owner = await newPlayer();
    const thief = await newPlayer();
    const reward = await leave(owner);

    await expect(claims().claim(thief, reward.id, randomUUID())).rejects.toBeInstanceOf(
      RankRewardNotFoundError,
    );
    await expect(claims().claim(owner, randomUUID(), randomUUID())).rejects.toBeInstanceOf(
      RankRewardNotFoundError,
    );
    expect(credit).not.toHaveBeenCalled();
    expect((await rewardRow(reward.id))?.status).toBe('claimable');
  });

  it('refuses a player under an active responsible-gambling block, and keeps the reward', async () => {
    const userId = await newPlayer();
    const reward = await leave(userId);
    isRestricted.mockResolvedValue(true);

    await expect(claims().claim(userId, reward.id, randomUUID())).rejects.toBeInstanceOf(
      RankRewardClaimRestrictedError,
    );
    expect(credit).not.toHaveBeenCalled();
    expect((await rewardRow(reward.id))?.status).toBe('claimable');
  });

  it('refuses a self-excluded player', async () => {
    const userId = await newPlayer('self_excluded');
    const reward = await leave(userId);

    await expect(claims().claim(userId, reward.id, randomUUID())).rejects.toBeInstanceOf(
      RankRewardClaimRestrictedError,
    );
  });

  it.each(['suspended', 'closed'] as const)('refuses a %s account', async (status) => {
    const userId = await newPlayer(status);
    const reward = await leave(userId);

    await expect(claims().claim(userId, reward.id, randomUUID())).rejects.toBeInstanceOf(
      RankRewardAccountBlockedError,
    );
    expect(credit).not.toHaveBeenCalled();
  });

  it('rolls the claim back when the wallet refuses the credit', async () => {
    const userId = await newPlayer();
    const reward = await leave(userId);
    credit.mockResolvedValue({ ok: false, reason: 'wallet not found' });

    await expect(claims().claim(userId, reward.id, randomUUID())).rejects.toThrow(
      /wallet not found/,
    );
    expect(await rewardRow(reward.id)).toMatchObject({ status: 'claimable', settledAt: null });
  });

  it('rolls the claim back when the audit write fails', async () => {
    const userId = await newPlayer();
    const reward = await leave(userId);
    recordInTransaction.mockRejectedValueOnce(new Error('audit down'));

    await expect(claims().claim(userId, reward.id, randomUUID())).rejects.toThrow(/audit down/);
    expect((await rewardRow(reward.id))?.status).toBe('claimable');
  });
});

describe('the rank rewards a player reads', () => {
  it('lists the claimable rewards oldest first and the paid ones after', async () => {
    const userId = await newPlayer();
    const paid = await leave(userId, '1');
    const older = await leave(userId, '2');
    const newer = await leave(userId, '3', 'EUR');
    await leave(await newPlayer(), '9');
    await claims().claim(userId, paid.id, randomUUID());

    const list = await claims().list(userId);

    expect(list.claimable.map((r) => r.id)).toEqual([older.id, newer.id]);
    expect(list.recent).toEqual([
      expect.objectContaining({ id: paid.id, status: 'claimed', settledAt: expect.any(String) }),
    ]);
    expect(list.claimBlockedBy).toBeNull();
  });

  it('says what blocks a claim', async () => {
    const restricted = await newPlayer();
    isRestricted.mockImplementation(async (id) => id === restricted);
    const closed = await newPlayer('closed');

    expect((await claims().list(restricted)).claimBlockedBy).toBe('restricted');
    expect((await claims().list(closed)).claimBlockedBy).toBe('account_blocked');
  });
});

describe('rank reward auto-payout', () => {
  it('pays every unclaimed reward of a self-excluded player, once', async () => {
    const userId = await newPlayer('self_excluded');
    const a = await leave(userId, '1');
    const b = await leave(userId, '2');

    const first = await claims().autoPay(userId);
    const second = await claims().autoPay(userId);

    expect(first.map((paid) => paid.rewardId).sort()).toEqual([a.id, b.id].sort());
    expect(first.every((paid) => paid.outcome === 'auto_paid')).toBe(true);
    expect(second).toEqual([]);
    expect(credit).toHaveBeenCalledTimes(2);
    expect(isRestricted).not.toHaveBeenCalled();
    expect((await rewardRow(a.id))?.status).toBe('auto_paid');
    expect(recordInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorId: null,
        actorType: 'system',
        action: 'promo.rank_reward.auto_paid',
        resourceId: a.id,
      }),
    );
  });

  it('pays a closed account', async () => {
    const userId = await newPlayer('closed');
    const reward = await leave(userId);

    expect(await claims().autoPay(userId)).toHaveLength(1);
    expect((await rewardRow(reward.id))?.status).toBe('auto_paid');
  });

  it('pays a player self-excluded through the RG module rather than the account status', async () => {
    const userId = await newPlayer();
    await leave(userId);
    getExclusionState.mockResolvedValue({ isSelfExcluded: true, isCoolingOff: false });

    expect(await claims().autoPay(userId)).toHaveLength(1);
  });

  it('keeps the reward of a cooling-off or active player for them to claim', async () => {
    const userId = await newPlayer();
    const reward = await leave(userId);
    getExclusionState.mockResolvedValue({ isSelfExcluded: false, isCoolingOff: true });

    expect(await claims().autoPay(userId)).toEqual([]);
    expect(credit).not.toHaveBeenCalled();
    expect((await rewardRow(reward.id))?.status).toBe('claimable');
  });

  it('pays once when two auto-payouts for the same player race', async () => {
    const userId = await newPlayer('closed');
    await leave(userId);

    await Promise.allSettled([claims().autoPay(userId), claims().autoPay(userId)]);

    expect(credit).toHaveBeenCalledTimes(1);
  });

  it('finds closed and self-excluded players holding a reward, but not a cooling-off one', async () => {
    const active = await newPlayer();
    const closed = await newPlayer('closed');
    const excluded = await newPlayer('self_excluded');
    const blockedExcluded = await newPlayer();
    const coolingOff = await newPlayer();
    await newPlayer('closed');
    for (const userId of [active, closed, excluded, blockedExcluded, coolingOff]) {
      await leave(userId);
    }
    await db.drizzle.db.update(user).set({ rgBlocked: true }).where(eq(user.id, blockedExcluded));
    await db.drizzle.db.update(user).set({ rgBlocked: true }).where(eq(user.id, coolingOff));
    getExclusionState.mockImplementation(async (userId) => ({
      isSelfExcluded: userId === blockedExcluded,
      isCoolingOff: userId === coolingOff,
    }));

    const due = await claims().dueForAutoPayout();

    expect([...due].sort()).toEqual([closed, excluded, blockedExcluded].sort());
  });
});

describe('the rank rewards an admin reads', () => {
  it('pages them filtered by player, status and kind', async () => {
    const userId = await newPlayer();
    const paid = await leave(userId);
    await leave(userId);
    await leave(await newPlayer());
    await claims().claim(userId, paid.id, randomUUID());

    const page = await claims().adminList({ page: 1, limit: 10, userId, status: 'claimed' });

    expect(page).toMatchObject({ total: 1, page: 1, limit: 10 });
    expect(page.items).toEqual([
      expect.objectContaining({
        id: paid.id,
        userId,
        status: 'claimed',
        ladderCurrency: 'USD',
        transactionId: expect.any(String),
      }),
    ]);
    expect((await claims().adminList({ page: 1, limit: 10, kind: 'weekly' })).total).toBe(0);
  });
});

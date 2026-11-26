import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as z from 'zod';
import { JOB_QUEUE, queue } from '@openora/core/contracts';
import { DRIZZLE } from '@openora/core/server';
import { auditLog } from '@openora/core/audit/schema';
import {
  promoPlayerRank,
  promoRankConfig,
  promoRankPeriodicReward,
  promoRankPeriodPayout,
  promoRankPeriodWager,
  promoRankTier,
} from '@openora/core/promo/schema/gamification';
import { flushAudit, newPlayer } from '../index.js';
import { balanceOf, bootWalletE2e, closeWalletE2e, type WalletE2e } from './support/wallet.js';
import {
  allLedgerRowsOf,
  bodyOf,
  fundedBettor,
  gameAdapterPlugin,
  geoIpPlugin,
} from './support/casino.js';
import { eventually, wager } from './support/gamification-rewards.js';

const ErrorSchema = z.object({ code: z.string(), status: z.number() });
const TierSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  position: z.number(),
  wagerThreshold: z.string(),
});
const LadderSchema = z.object({ currency: z.string(), tiers: z.array(TierSchema) });
const PlayerRankSchema = z.object({
  currency: z.string(),
  lifetimeWagered: z.string(),
  tierId: z.string().nullable(),
  tiers: z.array(TierSchema),
});
const RewardSchema = z.object({
  id: z.string(),
  kind: z.string(),
  periodKey: z.string(),
  currency: z.string(),
  amount: z.string(),
  status: z.string(),
});
const RewardsSchema = z.object({
  claimable: z.array(RewardSchema),
  recent: z.array(RewardSchema),
  claimBlockedBy: z.string().nullable(),
});
const ClaimSchema = z.object({
  rewardId: z.string(),
  kind: z.string(),
  currency: z.string(),
  amount: z.string(),
});

const tier = (key: string, wagerThreshold: string, extra: Record<string, unknown> = {}) => ({
  key,
  name: `Tier ${key}`,
  wagerThreshold,
  rakebackPercent: '0.5',
  dailyBonus: null,
  weeklyBonus: null,
  monthlyBonus: null,
  levelUpBonus: null,
  ...extra,
});

const ladderBody = (tiers: ReturnType<typeof tier>[]) => ({ currency: 'USD', tiers });

const configBody = {
  eligibleProducts: ['casino'],
  rakebackEligibleProducts: ['casino'],
  rewards: { daily: { payout: 'claim' } },
};

const unauthenticated = (e2e: WalletE2e, path: string, method = 'GET') =>
  e2e.app.app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify({}) } : {}),
  });

async function configureRanks(e2e: WalletE2e) {
  const ladder = await e2e.admin.put(
    '/backoffice/promo/ranks',
    ladderBody([tier('bronze', '0'), tier('silver', '5', { dailyBonus: '3' })]),
  );
  expect(ladder.status).toBe(200);
  const config = await e2e.admin.put('/backoffice/promo/ranks/config', configBody);
  expect(config.status).toBe(200);
  return LadderSchema.parse(await bodyOf(ladder));
}

describe('player rank and rewards', () => {
  let e2e: WalletE2e;
  let ladder: z.infer<typeof LadderSchema>;

  beforeAll(async () => {
    e2e = await bootWalletE2e([geoIpPlugin, gameAdapterPlugin]);
    ladder = await configureRanks(e2e);
  }, 120_000);

  afterAll(() => closeWalletE2e(e2e));

  const db = () => e2e.app.container.get(DRIZZLE).db;
  const bronze = () => ladder.tiers.find((entry) => entry.key === 'bronze');
  const silver = () => ladder.tiers.find((entry) => entry.key === 'silver');

  const insertRank = async (userId: string, tierId: string) => {
    await db().insert(promoPlayerRank).values({
      userId,
      currency: 'USD',
      lifetimeWagered: '10',
      tierId,
      announcedTierId: tierId,
    });
  };

  const insertClaimable = async (userId: string, amount = '3') => {
    const [row] = await db()
      .insert(promoRankPeriodicReward)
      .values({
        userId,
        kind: 'daily',
        periodKey: `rank-daily:fixture-${randomUUID()}`,
        periodStart: new Date(Date.now() - 2 * 86_400_000),
        periodEnd: new Date(Date.now() - 86_400_000),
        tierId: silver()?.id ?? randomUUID(),
        ladderCurrency: 'USD',
        ladderAmount: amount,
        currency: 'USD',
        amount,
      })
      .returning();
    if (!row) {
      throw new Error('reward fixture was not inserted');
    }
    return row;
  };

  const claim = (
    client: { post(path: string, body?: unknown): Promise<Response> },
    rewardId: string,
    idempotencyKey = randomUUID(),
  ) => client.post(`/promo/ranks/rewards/${rewardId}/claim`, { rewardId, idempotencyKey });

  const cashbackRows = async (userId: string) =>
    (await allLedgerRowsOf(e2e, userId)).filter((row) => row.type === 'cashback');

  it('wagering past a tier threshold promotes the player and the rank read shows the new tier', async () => {
    const bettor = await fundedBettor(e2e);
    const bronzeId = bronze()?.id;
    const silverId = silver()?.id;

    await wager(e2e, bettor, '2');
    await eventually(async () => {
      const res = await bettor.client.get('/promo/ranks');
      expect(res.status).toBe(200);
      const rank = PlayerRankSchema.parse(await bodyOf(res));
      expect(rank.lifetimeWagered).toBe('3.000000000000000000');
      expect(rank.tierId).toBe(bronzeId);
    });

    await wager(e2e, bettor, '2');
    await eventually(async () => {
      const res = await bettor.client.get('/promo/ranks');
      const rank = PlayerRankSchema.parse(await bodyOf(res));
      expect(rank.lifetimeWagered).toBe('6.000000000000000000');
      expect(rank.tierId).toBe(silverId);
    });
  });

  it('the ladder read is public and lists tiers in order', async () => {
    const res = await unauthenticated(e2e, '/promo/ranks/ladder');

    expect(res.status).toBe(200);
    const read = LadderSchema.parse(await bodyOf(res));
    expect(read.currency).toBe('USD');
    expect(read.tiers.map((entry) => [entry.position, entry.key, entry.wagerThreshold])).toEqual([
      [0, 'bronze', '0.000000000000000000'],
      [1, 'silver', '5.000000000000000000'],
    ]);
  });

  it('the rank lookup by user ids returns only public rank fields and deduplicates ids', async () => {
    const ranked = await newPlayer(e2e.app, 'rank-lookup');
    const unranked = await newPlayer(e2e.app, 'rank-lookup-none');
    await insertRank(ranked.userId, silver()?.id ?? '');

    const res = await e2e.app.app.request('/promo/ranks/lookup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userIds: [ranked.userId, unranked.userId, ranked.userId] }),
    });

    expect(res.status).toBe(200);
    const entries = z.array(z.record(z.string(), z.unknown())).parse(await bodyOf(res));
    expect(entries).toHaveLength(2);
    expect(entries).toContainEqual({
      userId: ranked.userId,
      tierKey: 'silver',
      tierName: 'Tier silver',
    });
    expect(entries).toContainEqual({ userId: unranked.userId, tierKey: null, tierName: null });
  });

  it('claiming a rank reward credits it once and a repeated claim is refused', async () => {
    const owed = await newPlayer(e2e.app, 'rank-claim');
    const inactive = await newPlayer(e2e.app, 'rank-claim-idle');
    const silverId = silver()?.id ?? '';
    await insertRank(owed.userId, silverId);
    await insertRank(inactive.userId, silverId);
    const yesterday = new Date(Date.now() - 86_400_000);
    const periodKey = `rank-daily:${yesterday.toISOString().slice(0, 10)}T00`;
    await db().delete(promoRankPeriodPayout).where(eq(promoRankPeriodPayout.periodKey, periodKey));
    await db()
      .insert(promoRankPeriodWager)
      .values({ userId: owed.userId, kind: 'daily', periodKey, currency: 'USD', wagered: '1' });

    await e2e.app.container.get(JOB_QUEUE).enqueue(queue('promo-rank-payout'), { kind: 'daily' });
    await eventually(async () => {
      const [config] = await db().select().from(promoRankConfig);
      expect(config?.paidThrough.daily).toBeDefined();
    }, 20_000);

    const [reward] = await db()
      .select()
      .from(promoRankPeriodicReward)
      .where(eq(promoRankPeriodicReward.userId, owed.userId));
    expect(reward).toMatchObject({
      kind: 'daily',
      periodKey,
      status: 'claimable',
      currency: 'USD',
      amount: '3.000000000000000000',
    });
    expect(
      await db()
        .select()
        .from(promoRankPeriodicReward)
        .where(eq(promoRankPeriodicReward.userId, inactive.userId)),
    ).toEqual([]);
    const rewardId = reward?.id ?? '';
    const listed = RewardsSchema.parse(await bodyOf(await owed.client.get('/promo/ranks/rewards')));
    expect(listed.claimable.map((entry) => entry.id)).toEqual([rewardId]);
    expect(await balanceOf(e2e, owed.userId, 'USD')).toBe('0');

    const key = randomUUID();
    const first = await claim(owed.client, rewardId, key);
    expect(first.status).toBe(200);
    expect(ClaimSchema.parse(await bodyOf(first))).toEqual({
      rewardId,
      kind: 'daily',
      currency: 'USD',
      amount: '3.000000000000000000',
    });
    expect(await balanceOf(e2e, owed.userId, 'USD')).toBe('3.000000000000000000');
    expect(await cashbackRows(owed.userId)).toEqual([
      expect.objectContaining({
        amount: '3.000000000000000000',
        direction: 'credit',
        providerRefId: rewardId,
      }),
    ]);

    const replay = await claim(owed.client, rewardId, key);
    expect(replay.status).toBe(200);
    const refused = await claim(owed.client, rewardId);
    expect(refused.status).toBe(409);
    expect(ErrorSchema.parse(await bodyOf(refused)).code).toBe('CONFLICT');
    expect(await balanceOf(e2e, owed.userId, 'USD')).toBe('3.000000000000000000');
    expect(await cashbackRows(owed.userId)).toHaveLength(1);
    const [settled] = await db()
      .select()
      .from(promoRankPeriodicReward)
      .where(eq(promoRankPeriodicReward.id, rewardId));
    expect(settled).toMatchObject({ status: 'claimed', idempotencyKey: key });
    expect(await balanceOf(e2e, inactive.userId, 'USD')).toBe('0');
    await flushAudit(e2e.app);
    const audit = await db()
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, 'promo.rank_reward.claimed'), eq(auditLog.resourceId, rewardId)),
      );
    expect(audit).toHaveLength(1);
  });

  it('claiming a rank reward that does not exist or belongs to another player returns not found', async () => {
    const owner = await newPlayer(e2e.app, 'rank-owner');
    const other = await newPlayer(e2e.app, 'rank-other');
    const reward = await insertClaimable(owner.userId);

    const foreign = await claim(other.client, reward.id);
    const missing = await claim(other.client, randomUUID());

    expect(foreign.status).toBe(404);
    expect(ErrorSchema.parse(await bodyOf(foreign)).code).toBe('NOT_FOUND');
    expect(missing.status).toBe(404);
    expect(ErrorSchema.parse(await bodyOf(missing)).code).toBe('NOT_FOUND');
    const [untouched] = await db()
      .select()
      .from(promoRankPeriodicReward)
      .where(eq(promoRankPeriodicReward.id, reward.id));
    expect(untouched?.status).toBe('claimable');
    expect(await balanceOf(e2e, owner.userId, 'USD')).toBe('0');
    expect(await balanceOf(e2e, other.userId, 'USD')).toBe('0');
    expect(await cashbackRows(owner.userId)).toEqual([]);
    expect(await cashbackRows(other.userId)).toEqual([]);
  });

  it('reading own rank or rewards without a session is rejected as unauthorized', async () => {
    const owner = await newPlayer(e2e.app, 'rank-anon');
    const reward = await insertClaimable(owner.userId);

    const rank = await unauthenticated(e2e, '/promo/ranks');
    const rewards = await unauthenticated(e2e, '/promo/ranks/rewards');
    const claimed = await e2e.app.app.request(`/promo/ranks/rewards/${reward.id}/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rewardId: reward.id, idempotencyKey: randomUUID() }),
    });

    expect(rank.status).toBe(401);
    expect(rewards.status).toBe(401);
    expect(claimed.status).toBe(401);
    const [untouched] = await db()
      .select()
      .from(promoRankPeriodicReward)
      .where(eq(promoRankPeriodicReward.id, reward.id));
    expect(untouched?.status).toBe('claimable');
    expect(await balanceOf(e2e, owner.userId, 'USD')).toBe('0');
  });
});

describe('admin rank ladder', () => {
  let e2e: WalletE2e;

  beforeAll(async () => {
    e2e = await bootWalletE2e();
  }, 120_000);

  afterAll(() => closeWalletE2e(e2e));

  const db = () => e2e.app.container.get(DRIZZLE).db;

  it('an admin sets the ladder and the change is audited', async () => {
    const key = `gold-${randomUUID().slice(0, 8)}`;

    const res = await e2e.admin.put(
      '/backoffice/promo/ranks',
      ladderBody([tier('base', '0'), tier(key, '25')]),
    );

    expect(res.status).toBe(200);
    const set = LadderSchema.parse(await bodyOf(res));
    expect(set.tiers.map((entry) => [entry.key, entry.wagerThreshold])).toEqual([
      ['base', '0.000000000000000000'],
      [key, '25.000000000000000000'],
    ]);
    const read = LadderSchema.parse(await bodyOf(await e2e.admin.get('/backoffice/promo/ranks')));
    expect(read).toEqual(set);
    await flushAudit(e2e.app);
    const audit = await db()
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'promo.rank_ladder.set'));
    expect(audit.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit.map((row) => row.after))).toContain(key);
  });

  it('a ladder with overlapping or unordered thresholds is refused', async () => {
    const valid = await e2e.admin.put(
      '/backoffice/promo/ranks',
      ladderBody([tier('low', '0'), tier('high', '10')]),
    );
    expect(valid.status).toBe(200);
    const before = LadderSchema.parse(await bodyOf(valid));

    const overlapping = await e2e.admin.put(
      '/backoffice/promo/ranks',
      ladderBody([tier('low', '0'), tier('mid', '10'), tier('high', '10')]),
    );
    const unordered = await e2e.admin.put(
      '/backoffice/promo/ranks',
      ladderBody([tier('low', '0'), tier('mid', '10'), tier('high', '5')]),
    );
    const noZeroStart = await e2e.admin.put(
      '/backoffice/promo/ranks',
      ladderBody([tier('low', '1'), tier('high', '10')]),
    );

    for (const res of [overlapping, unordered, noZeroStart]) {
      expect(res.status).toBe(400);
      expect(ErrorSchema.parse(await bodyOf(res)).code).toBe('BAD_REQUEST');
    }
    const after = LadderSchema.parse(await bodyOf(await e2e.admin.get('/backoffice/promo/ranks')));
    expect(after).toEqual(before);
  });

  it('a non-admin setting the ladder or config is refused as forbidden', async () => {
    const player = await newPlayer(e2e.app, 'rank-nonadmin');
    const valid = await e2e.admin.put(
      '/backoffice/promo/ranks',
      ladderBody([tier('floor', '0'), tier('roof', '40')]),
    );
    const before = LadderSchema.parse(await bodyOf(valid));

    const ladder = await player.client.put(
      '/backoffice/promo/ranks',
      ladderBody([tier('hacked', '0')]),
    );
    const config = await player.client.put('/backoffice/promo/ranks/config', configBody);

    expect(ladder.status).toBe(403);
    expect(ErrorSchema.parse(await bodyOf(ladder)).code).toBe('FORBIDDEN');
    expect(config.status).toBe(403);
    expect(ErrorSchema.parse(await bodyOf(config)).code).toBe('FORBIDDEN');
    const after = LadderSchema.parse(await bodyOf(await e2e.admin.get('/backoffice/promo/ranks')));
    expect(after).toEqual(before);
  });
});

describe('admin rank ladder before configuration', () => {
  let e2e: WalletE2e;

  beforeAll(async () => {
    e2e = await bootWalletE2e();
    await e2e.app.container.get(DRIZZLE).db.delete(promoRankTier);
  }, 120_000);

  afterAll(() => closeWalletE2e(e2e));

  it('reading the admin ladder before one is configured returns not configured', async () => {
    const res = await e2e.admin.get('/backoffice/promo/ranks');

    expect(res.status).toBe(404);
    expect(ErrorSchema.parse(await bodyOf(res)).code).toBe('NOT_FOUND');
  });
});

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { DRIZZLE } from '@openora/core/server';
import { PLAY_ELIGIBILITY_PROJECTION } from '@openora/core/contracts';
import { backfillPlayEligibility } from '@openora/core/pam/identity/seed';
import { walletTransaction } from '@openora/core/wallet/schema';
import { user } from '@openora/core/pam/schema/identity';
import { promoRankPeriodicReward } from '@openora/core/promo/schema/gamification';
import {
  asAdmin,
  bootE2e,
  closeE2e,
  flushAudit,
  readJson,
  registerAndMaterializePlayer,
  type TestApp,
  type TestClient,
  type TestDb,
} from '../index.js';
import { EXAMPLE_RANK_LADDER } from '../seed.js';

let db: TestDb;
let app: TestApp;
let admin: TestClient;

const CONFIG_PATH = '/backoffice/promo/ranks/config';

const drizzle = () => app.container.get(DRIZZLE).db;

// A direct write bypasses identity's publisher, so re-project as a script would; the platform's
// RG routes would also end the login the claim needs.
const reproject = () =>
  backfillPlayEligibility(drizzle(), app.container.get(PLAY_ELIGIBILITY_PROJECTION));

const newPlayer = () =>
  registerAndMaterializePlayer(app, { email: `rank-reward-${randomUUID()}@example.test` });

const leave = async (userId: string, amount = '1.5') => {
  const [row] = await drizzle()
    .insert(promoRankPeriodicReward)
    .values({
      userId,
      kind: 'weekly',
      periodKey: `rank-weekly:${randomUUID()}`,
      periodStart: new Date('2026-09-14T00:00:00Z'),
      periodEnd: new Date('2026-09-21T00:00:00Z'),
      tierId: randomUUID(),
      ladderCurrency: 'USDT',
      ladderAmount: amount,
      currency: 'USDT',
      amount,
    })
    .returning();
  return row!;
};

const claim = (client: TestClient, rewardId: string, idempotencyKey: string = randomUUID()) =>
  client.post(`/promo/ranks/rewards/${rewardId}/claim`, { idempotencyKey });

const credits = (rewardId: string) =>
  drizzle()
    .select({ amount: walletTransaction.amount, type: walletTransaction.type })
    .from(walletTransaction)
    .where(eq(walletTransaction.providerRefId, rewardId));

beforeAll(async () => {
  ({ db, app } = await bootE2e());
  admin = await asAdmin(app.app);
}, 60_000);

afterAll(async () => {
  await closeE2e({ app, db });
});

describe('an operator switching a periodic rank reward to claim', () => {
  afterEach(async () => {
    await admin.put(CONFIG_PATH, EXAMPLE_RANK_LADDER.config);
  });

  it('saves a claim-mode kind with no bonus terms, and keeps level-up a bonus', async () => {
    const config = {
      ...EXAMPLE_RANK_LADDER.config,
      rewards: {
        ...EXAMPLE_RANK_LADDER.config.rewards,
        weekly: { payout: 'claim', wageringMultiplier: '5', expiryDays: 3 },
      },
    };

    const res = await admin.put(CONFIG_PATH, config);

    expect(res.status).toBe(200);
    const saved = await readJson(await admin.get(CONFIG_PATH));
    expect(saved.rewards.weekly).toEqual({ payout: 'claim' });
    expect(saved.rewards.levelUp).toEqual(EXAMPLE_RANK_LADDER.config.rewards.levelUp);
  });

  it("shows each kind's payout on the public ladder and the player's rank", async () => {
    const { client } = await newPlayer();
    const before = await readJson(await app.app.request('/promo/ranks/ladder'));
    expect(before.periodicPayout).toEqual({ daily: 'bonus', weekly: 'bonus', monthly: 'bonus' });

    await admin.put(CONFIG_PATH, {
      ...EXAMPLE_RANK_LADDER.config,
      rewards: { ...EXAMPLE_RANK_LADDER.config.rewards, weekly: { payout: 'claim' } },
    });

    const expected = { daily: 'bonus', weekly: 'claim', monthly: 'bonus' };
    const ladder = await app.app.request('/promo/ranks/ladder');
    expect(ladder.status).toBe(200);
    expect((await readJson(ladder)).periodicPayout).toEqual(expected);
    expect((await readJson(await client.get('/promo/ranks'))).periodicPayout).toEqual(expected);
  });

  it.each([
    ['on its own', { payout: 'claim' }],
    ['with full terms', { payout: 'claim', wageringMultiplier: '5', expiryDays: 14 }],
  ])('refuses claim mode on the level-up reward %s', async (_label, levelUp) => {
    const res = await admin.put(CONFIG_PATH, {
      ...EXAMPLE_RANK_LADDER.config,
      rewards: { ...EXAMPLE_RANK_LADDER.config.rewards, levelUp },
    });

    expect(res.status).toBe(400);
    const saved = await readJson(await admin.get(CONFIG_PATH));
    expect(saved.rewards.levelUp).toEqual(EXAMPLE_RANK_LADDER.config.rewards.levelUp);
  });
});

describe('a player claiming a periodic rank reward', () => {
  it('lists it, pays it as cashback once, and replays a retry', async () => {
    const { client, userId } = await newPlayer();
    const reward = await leave(userId);

    const listed = await readJson(await client.get('/promo/ranks/rewards'));
    expect(listed).toEqual({
      claimable: [
        expect.objectContaining({
          id: reward.id,
          kind: 'weekly',
          currency: 'USDT',
          amount: '1.500000000000000000',
          status: 'claimable',
          settledAt: null,
        }),
      ],
      recent: [],
      claimBlockedBy: null,
    });

    const key = randomUUID();
    const res = await claim(client, reward.id, key);
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({
      rewardId: reward.id,
      kind: 'weekly',
      currency: 'USDT',
      amount: '1.500000000000000000',
    });
    expect(await credits(reward.id)).toEqual([
      { amount: '1.500000000000000000', type: 'cashback' },
    ]);

    const retry = await claim(client, reward.id, key);
    expect(retry.status).toBe(200);
    expect(await credits(reward.id)).toHaveLength(1);

    const again = await claim(client, reward.id);
    expect(again.status).toBe(409);
    expect((await readJson(again)).data).toEqual({ reason: 'already_claimed' });

    const after = await readJson(await client.get('/promo/ranks/rewards'));
    expect(after.claimable).toEqual([]);
    expect(after.recent).toEqual([expect.objectContaining({ id: reward.id, status: 'claimed' })]);

    await flushAudit(app);
    const audit = await readJson(
      await admin.get(`/audit/logs?resourceId=${reward.id}&action=promo.rank_reward.claimed`),
    );
    expect(audit.items).toEqual([
      expect.objectContaining({ actorType: 'player', actorId: userId }),
    ]);
  });

  it("cannot claim another player's reward", async () => {
    const owner = await newPlayer();
    const { client } = await newPlayer();
    const reward = await leave(owner.userId);

    const res = await claim(client, reward.id);

    expect(res.status).toBe(404);
    expect(await credits(reward.id)).toEqual([]);
  });

  it('is refused under a responsible-gambling block and kept for later', async () => {
    const { client, userId } = await newPlayer();
    const reward = await leave(userId);
    await drizzle()
      .update(user)
      .set({ rgBlocked: true, playEligibilityVersion: sql`${user.playEligibilityVersion} + 1` })
      .where(eq(user.id, userId));
    await reproject();

    const res = await claim(client, reward.id);

    expect(res.status).toBe(403);
    expect((await readJson(res)).data).toEqual({ reason: 'restricted' });
    const listed = await readJson(await client.get('/promo/ranks/rewards'));
    expect(listed.claimBlockedBy).toBe('restricted');
    expect(listed.claimable).toHaveLength(1);
  });

  it('is refused outright when signed out', async () => {
    const res = await app.app.request(`/promo/ranks/rewards/${randomUUID()}/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idempotencyKey: randomUUID() }),
    });

    expect(res.status).toBe(401);
  });
});

describe('the periodic rank rewards an admin reads', () => {
  it("shows a player's rewards with their wallet transaction", async () => {
    const { client, userId } = await newPlayer();
    const reward = await leave(userId);
    await claim(client, reward.id);

    const res = await admin.get(`/backoffice/promo/ranks/rewards?userId=${userId}`);

    expect(res.status).toBe(200);
    expect(await readJson(res)).toMatchObject({
      total: 1,
      items: [{ id: reward.id, userId, status: 'claimed', transactionId: expect.any(String) }],
    });
  });

  it('is refused to a player', async () => {
    const { client } = await newPlayer();

    const res = await client.get('/backoffice/promo/ranks/rewards');

    expect(res.status).toBe(403);
  });
});

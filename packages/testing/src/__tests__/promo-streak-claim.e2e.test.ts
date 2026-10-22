import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, like } from 'drizzle-orm';
import { loadExtensions, DRIZZLE, EVENT_BUS } from '@openora/core/server';
import { WAGER_TRACKING } from '@openora/core/contracts';
import { walletTransaction } from '@openora/core/wallet/schema';
import { user } from '@openora/core/pam/schema/identity';
import {
  promoStreakConfig,
  promoStreakMilestoneGrant,
} from '@openora/core/promo/schema/gamification';
import {
  setupTestDb,
  bootTestApp,
  seedMinimal,
  registerAndMaterializePlayer,
  asAdmin,
  type TestDb,
  type TestApp,
  type TestClient,
} from '../index.js';

const JOB_WAIT = { timeout: 15000, interval: 100 };

let db: TestDb;
let app: TestApp;
let admin: TestClient;
let savedConfig: (typeof promoStreakConfig.$inferSelect)[] = [];

const drizzle = () => app.container.get(DRIZZLE).db;

// oxlint-disable-next-line typescript/no-explicit-any -- ad-hoc JSON shape assertions in tests
async function readJson(res: Response): Promise<any> {
  return res.json();
}

const qualify = (userId: string) =>
  drizzle().transaction((tx) =>
    app.container.get(WAGER_TRACKING).recordWager(tx, {
      userId,
      currency: 'USD',
      amount: '10',
      weightedAmount: '10',
      realAmount: '10',
      context: { provider: 'aggregator', product: 'casino' },
    }),
  );

const creditsFor = (milestoneGrantId: string) =>
  drizzle()
    .select({ amount: walletTransaction.amount })
    .from(walletTransaction)
    .where(like(walletTransaction.providerRefId, `streak-milestone:${milestoneGrantId}:%`));

async function playerWithWaitingReward() {
  const player = await registerAndMaterializePlayer(app, {
    email: `streak-claim-${randomUUID()}@example.test`,
  });
  await qualify(player.userId);
  const { claimable } = await readJson(await player.client.get('/promo/streaks'));
  expect(claimable).toEqual([{ id: expect.any(String), day: 1 }]);
  return { ...player, milestoneGrantId: claimable[0].id as string };
}

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['WITHDRAWAL_PIN_HMAC_SECRET'] ??= 'e2e-test-withdrawal-pin-hmac-secret-000000';
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  app = await bootTestApp({ plugins: await loadExtensions(), databaseUrl: db.url });
  await seedMinimal(app.container, { playerCount: 0 });
  admin = await asAdmin(app.app);

  savedConfig = await drizzle().select().from(promoStreakConfig);
  await drizzle().delete(promoStreakConfig);
  await drizzle()
    .insert(promoStreakConfig)
    .values({
      currency: 'USD',
      dailyMinWager: '10',
      eligibleProducts: [],
      milestones: [{ day: 1, rewards: [{ kind: 'cash', amount: '5' }] }],
      resetAfterDay: 30,
    });
}, 60_000);

afterAll(async () => {
  await drizzle().delete(promoStreakConfig);
  if (savedConfig.length > 0) {
    await drizzle().insert(promoStreakConfig).values(savedConfig);
  }
  await app.close();
  await db.dispose();
});

describe('a player claiming a streak milestone reward', () => {
  it('credits the reward once, and a repeated claim is refused', async () => {
    const { client, milestoneGrantId } = await playerWithWaitingReward();

    const first = await client.post('/promo/streaks/claim', { milestoneGrantId });
    const repeated = await client.post('/promo/streaks/claim', { milestoneGrantId });

    expect(first.status).toBe(200);
    expect(await readJson(first)).toEqual({ outcome: 'granted' });
    expect(repeated.status).toBe(404);
    expect(await creditsFor(milestoneGrantId)).toHaveLength(1);
    expect((await readJson(await client.get('/promo/streaks'))).claimable).toEqual([]);
  });

  it("refuses another player's reward and leaves it waiting for its owner", async () => {
    const owner = await playerWithWaitingReward();
    const { client: other } = await registerAndMaterializePlayer(app, {
      email: `streak-other-${randomUUID()}@example.test`,
    });

    const res = await other.post('/promo/streaks/claim', {
      milestoneGrantId: owner.milestoneGrantId,
    });

    expect(res.status).toBe(404);
    expect(await creditsFor(owner.milestoneGrantId)).toEqual([]);
    expect((await readJson(await owner.client.get('/promo/streaks'))).claimable).toEqual([
      { id: owner.milestoneGrantId, day: 1 },
    ]);
  });
});

const forfeitAudit = async (milestoneGrantId: string) =>
  (
    await readJson(
      await admin.get(
        `/audit/logs?resourceId=${milestoneGrantId}&action=promo.streak.milestone.forfeited`,
      ),
    )
  ).items;

const outcomeOf = async (milestoneGrantId: string) => {
  const [row] = await drizzle()
    .select({ outcome: promoStreakMilestoneGrant.outcome })
    .from(promoStreakMilestoneGrant)
    .where(eq(promoStreakMilestoneGrant.id, milestoneGrantId));
  return row?.outcome;
};

describe('a responsible-gambling block forfeiting unclaimed streak rewards', () => {
  it('forfeits on an admin cooling-off and names the admin on the audit row', async () => {
    const { userId, milestoneGrantId } = await playerWithWaitingReward();
    const [adminUser] = await drizzle()
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, 'admin@oss.dev'));

    const res = await admin.post(`/compliance/players/${userId}/cooling-off`, {
      durationHours: 24,
      reason: 'player requested a break',
    });
    expect(res.status).toBe(200);

    await vi.waitFor(async () => {
      expect(await forfeitAudit(milestoneGrantId)).toEqual([
        expect.objectContaining({ actorType: 'admin', actorId: adminUser?.id }),
      ]);
    }, JOB_WAIT);
    expect(await outcomeOf(milestoneGrantId)).toBe('restricted');
    expect(await creditsFor(milestoneGrantId)).toEqual([]);
  });

  it('records the system, not an admin, for a rule-triggered self-exclusion', async () => {
    const { userId, milestoneGrantId } = await playerWithWaitingReward();

    app.container.get(EVENT_BUS).emit('rg.self_exclusion.activated', {
      userId,
      playerId: null,
      exclusionId: randomUUID(),
      isPermanent: true,
      durationMonths: null,
      expiresAt: null,
      initiatedBy: 'system',
      actorId: randomUUID(),
      reason: 'rg rule triggered',
    });

    await vi.waitFor(async () => {
      expect(await forfeitAudit(milestoneGrantId)).toEqual([
        expect.objectContaining({ actorType: 'system', actorId: null }),
      ]);
    }, JOB_WAIT);
    expect(await outcomeOf(milestoneGrantId)).toBe('restricted');
  });
});

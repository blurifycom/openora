import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { loadExtensions, DRIZZLE } from '@openora/core/server';
import { WAGER_TRACKING } from '@openora/core/contracts';
import { walletTransaction } from '@openora/core/wallet/schema';
import { promoStreakConfig } from '@openora/core/promo/schema/gamification';
import {
  setupTestDb,
  bootTestApp,
  seedMinimal,
  registerAndMaterializePlayer,
  type TestDb,
  type TestApp,
} from '../index.js';

let db: TestDb;
let app: TestApp;
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
    .where(eq(walletTransaction.providerRefId, `streak-milestone:${milestoneGrantId}:0`));

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

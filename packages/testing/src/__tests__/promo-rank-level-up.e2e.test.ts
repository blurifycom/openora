import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { loadExtensions, DRIZZLE } from '@openora/core/server';
import { JOB_QUEUE, WAGER_TRACKING, queue } from '@openora/core/contracts';
import { user } from '@openora/core/pam/schema/identity';
import { adminRole, adminRoleAssignment } from '@openora/core/iam/schema';
import { promoGrant } from '@openora/core/promo/schema/bonus';
import {
  promoPlayerRank,
  promoRankLevelUp,
  promoRankTier,
} from '@openora/core/promo/schema/gamification';
import {
  setupTestDb,
  bootTestApp,
  seedMinimal,
  registerAndMaterializePlayer,
  type TestDb,
  type TestApp,
  type TestClient,
} from '../index.js';
import { EXAMPLE_RANK_LADDER } from '../seed.js';

let db: TestDb;
let app: TestApp;
let admin: TestClient;

const drizzle = () => app.container.get(DRIZZLE).db;

// The example ladder pays 10 at silver (10,000 wagered) and 50 at gold (100,000).
const SILVER_THRESHOLD = '10000';
const GOLD_THRESHOLD = '100000';
const LEVEL_UP_TERMS = { wageringMultiplier: '2', expiryDays: 7 };

// oxlint-disable-next-line typescript/no-explicit-any -- ad-hoc JSON shape assertions in tests
async function readJson(res: Response): Promise<any> {
  return res.json();
}

const wager = (userId: string, amount: string) =>
  drizzle().transaction((tx) =>
    app.container.get(WAGER_TRACKING).recordWager(tx, {
      userId,
      currency: 'USDT',
      amount,
      weightedAmount: amount,
      realAmount: amount,
      context: { provider: 'aggregator', product: 'casino' },
    }),
  );

/**
 * Fires what the cron fires; the job reads what is owed from the database. Delivery is durable
 * and asynchronous, so a caller waits for the outcome rather than for the enqueue.
 */
const settleLevelUps = () =>
  app.container.get(JOB_QUEUE).enqueue(queue('promo-rank-payout'), { kind: 'levelUp' });

const settledGrants = async (userId: string, count: number) => {
  await vi.waitFor(async () => expect(await rankGrants(userId)).toHaveLength(count));
  return rankGrants(userId);
};

const rankGrants = (userId: string) =>
  drizzle()
    .select({
      sourceRef: promoGrant.sourceRef,
      currency: promoGrant.currency,
      grantedAmount: promoGrant.grantedAmount,
      bonusBalance: promoGrant.bonusBalance,
      wageringRequired: promoGrant.wageringRequired,
      status: promoGrant.status,
    })
    .from(promoGrant)
    .where(and(eq(promoGrant.userId, userId), eq(promoGrant.source, 'rank')))
    .orderBy(promoGrant.createdAt);

const tierId = async (key: string) => {
  const [tier] = await drizzle()
    .select({ id: promoRankTier.id })
    .from(promoRankTier)
    .where(eq(promoRankTier.key, key));
  return tier?.id ?? '';
};

/** Fires what the announcement cron fires. */
const announceRankChanges = () =>
  app.container.get(JOB_QUEUE).enqueue(queue('promo-rank-announce'), {});

/** The announcement job has caught this player's marker up, told or not. */
const isCaughtUp = async (userId: string) => {
  const [row] = await drizzle()
    .select({ tierId: promoPlayerRank.tierId, announcedTierId: promoPlayerRank.announcedTierId })
    .from(promoPlayerRank)
    .where(eq(promoPlayerRank.userId, userId));
  return row !== undefined && row.announcedTierId === row.tierId;
};

type NotificationRow = { type: string; title: string; body: string; data: unknown };

const rankNotifications = async (client: TestClient): Promise<NotificationRow[]> => {
  const { items } = (await readJson(await client.get('/notifications'))) as {
    items: NotificationRow[];
  };
  return items.filter((n) => n.type === 'promo.rank.changed');
};

const owed = (userId: string) =>
  drizzle()
    .select({ outcome: promoRankLevelUp.outcome, grantId: promoRankLevelUp.grantId })
    .from(promoRankLevelUp)
    .where(eq(promoRankLevelUp.userId, userId));

async function newPlayer(label: string) {
  return registerAndMaterializePlayer(app, { email: `rank-levelup-${label}@example.test` });
}

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['WITHDRAWAL_PIN_HMAC_SECRET'] ??= 'e2e-test-withdrawal-pin-hmac-secret-000000';
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  app = await bootTestApp({ plugins: await loadExtensions(), databaseUrl: db.url });
  await seedMinimal(app.container, { playerCount: 0 });

  const { client, userId } = await newPlayer(randomUUID());
  await drizzle().update(user).set({ role: 'admin' }).where(eq(user.id, userId));
  const [role] = await drizzle()
    .select()
    .from(adminRole)
    .where(eq(adminRole.key, 'bonus-promotions'));
  if (!role) {
    throw new Error('no seeded bonus-promotions role');
  }
  await drizzle()
    .insert(adminRoleAssignment)
    .values({ userId, roleId: role.id })
    .onConflictDoNothing();
  admin = client;
  // The terms every level-up bonus below is granted under, set the way an operator sets them.
  await admin.put('/backoffice/promo/ranks/config', {
    ...EXAMPLE_RANK_LADDER.config,
    rewards: { ...EXAMPLE_RANK_LADDER.config.rewards, levelUp: LEVEL_UP_TERMS },
  });
}, 60_000);

afterAll(async () => {
  await app.close();
  await db.dispose();
});

describe('a player ranking up and the bonus it pays', () => {
  it('turns the tier reached into a real bonus grant the player can see', async () => {
    const { client, userId } = await newPlayer(randomUUID());

    await wager(userId, SILVER_THRESHOLD);
    await settleLevelUps();

    expect(await settledGrants(userId, 1)).toEqual([
      {
        sourceRef: `rank-level-up:${await tierId('silver')}`,
        currency: 'USDT',
        grantedAmount: '10.000000000000000000',
        bonusBalance: '10.000000000000000000',
        // The operator's multiplier, applied to the tier's amount.
        wageringRequired: '20.000000000000000000',
        status: 'active',
      },
    ]);
    const balance = await readJson(await client.get('/promo/balance'));
    expect(balance).toContainEqual(
      expect.objectContaining({ currency: 'USDT', bonus: '10.000000000000000000' }),
    );
    expect(await owed(userId)).toEqual([{ outcome: 'granted', grantId: expect.any(String) }]);
  });

  it('pays one bonus per tier when a single wager crosses two', async () => {
    const { userId } = await newPlayer(randomUUID());

    await wager(userId, GOLD_THRESHOLD);
    await settleLevelUps();

    expect(await settledGrants(userId, 2)).toEqual([
      expect.objectContaining({
        sourceRef: `rank-level-up:${await tierId('silver')}`,
        grantedAmount: '10.000000000000000000',
      }),
      expect.objectContaining({
        sourceRef: `rank-level-up:${await tierId('gold')}`,
        grantedAmount: '50.000000000000000000',
      }),
    ]);
  });

  it('grants nothing a second time when the job runs again', async () => {
    const { userId } = await newPlayer(randomUUID());
    await wager(userId, SILVER_THRESHOLD);

    await settleLevelUps();
    await settledGrants(userId, 1);
    await settleLevelUps();

    // A second run has nothing left to settle, so the count stays where it was.
    await vi.waitFor(async () => expect(await owed(userId)).toEqual([expect.anything()]));
    expect(await rankGrants(userId)).toHaveLength(1);
  });

  it('pays nothing more for wagering on inside a tier it already paid', async () => {
    const { userId } = await newPlayer(randomUUID());
    await wager(userId, SILVER_THRESHOLD);
    await settleLevelUps();
    await settledGrants(userId, 1);

    // Wagering on inside the tier changes nothing: the bonus belongs to reaching it.
    await wager(userId, '1');
    await settleLevelUps();

    await vi.waitFor(async () => expect(await owed(userId)).toHaveLength(1));
    expect(await rankGrants(userId)).toHaveLength(1);
  });
});

describe('a player ranking up and being told about it', () => {
  it("lands in the player's own inbox with the rank reached and what it pays", async () => {
    const { client, userId } = await newPlayer(randomUUID());

    await wager(userId, SILVER_THRESHOLD);
    await announceRankChanges();

    await vi.waitFor(
      async () =>
        expect(await rankNotifications(client)).toEqual([
          expect.objectContaining({
            title: 'You reached Silver rank',
            body: 'Congratulations on reaching Silver. Your rank now pays 3% rakeback and a bonus worth 5 USDT daily, 50 USDT monthly, plus a one-off 10 USDT level-up bonus.',
            data: { tierId: await tierId('silver') },
          }),
        ]),
      { timeout: 10_000 },
    );
  });

  it('tells the player once, however many times the job runs', async () => {
    const { client, userId } = await newPlayer(randomUUID());
    await wager(userId, SILVER_THRESHOLD);

    await announceRankChanges();
    await vi.waitFor(async () => expect(await rankNotifications(client)).toHaveLength(1), {
      timeout: 10_000,
    });
    await announceRankChanges();

    // A second run has nothing to announce for this player. Another player's notification landing
    // shows that run has finished, so the count is checked after it, not after a guess.
    const other = await newPlayer(randomUUID());
    await wager(other.userId, SILVER_THRESHOLD);
    await announceRankChanges();
    await vi.waitFor(async () => expect(await rankNotifications(other.client)).toHaveLength(1), {
      timeout: 10_000,
    });
    expect(await rankNotifications(client)).toHaveLength(1);
  });

  // The player's first bet puts them on the starting rank, which crosses nothing.
  it('says nothing about the rank every player starts on', async () => {
    const { client, userId } = await newPlayer(randomUUID());
    await wager(userId, '1');

    await announceRankChanges();

    await vi.waitFor(async () => expect(await isCaughtUp(userId)).toBe(true), { timeout: 10_000 });
    expect(await rankNotifications(client)).toEqual([]);
  });
});

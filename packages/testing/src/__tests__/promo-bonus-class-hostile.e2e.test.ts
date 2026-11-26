import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { DRIZZLE } from '@openora/core/server';
import { BONUS_GRANTS } from '@openora/core/contracts';
import { user } from '@openora/core/pam/schema/identity';
import { adminRole, adminRoleAssignment } from '@openora/core/iam/schema';
import { auditLog } from '@openora/core/audit/schema';
import { game, gameProvider, gameRound } from '@openora/core/casino/schema/gaming';
import { backfillLedgerGames } from '@openora/core/casino/seed/gaming';
import { wallet, walletBalance } from '@openora/core/wallet/schema';
import {
  promoGrant,
  promoGrantEntry,
  promoGrantRound,
  promoWeight,
  promoWeightProfile,
} from '@openora/core/promo/schema/bonus';
import {
  registerAndMaterializePlayer,
  type TestDb,
  type TestApp,
  type TestClient,
  bootE2e,
  closeE2e,
  readJson,
} from '../index.js';

let db: TestDb;
let app: TestApp;
let admin: TestClient;
let gameId: string;
let zeroCasinoProfileId: string;

const drizzle = () => app.container.get(DRIZZLE).db;

async function player(deposit: string) {
  const { client, userId } = await registerAndMaterializePlayer(app, {
    email: `class-hostile-${randomUUID()}@example.test`,
  });
  const res = await client.post('/wallet/deposit', {
    amount: deposit,
    currency: 'USD',
    idempotencyKey: randomUUID(),
  });
  if (res.status !== 200) {
    throw new Error(`deposit failed (${res.status}): ${await res.text()}`);
  }
  return { client, userId };
}

async function restrictedGrant(userId: string) {
  const outcome = await drizzle().transaction((tx) =>
    app.container.get(BONUS_GRANTS).grant(tx, {
      userId,
      currency: 'USD',
      amount: '50',
      source: 'deposit',
      sourceRef: randomUUID(),
      actor: { type: 'system' },
      buckets: { unlinked: '10', linked: '10' },
      terms: {
        wageringMultiplier: '10',
        expiryDays: 30,
        weightProfileId: zeroCasinoProfileId,
        funds: {
          rolloverBase: 'bonus',
          existingBalance: 'free',
          freeFundsOrder: 'first',
          dustThresholdUsd: '0',
          decimals: 2,
          betClassBuckets: { zero: ['unlinked', 'linked'] },
        },
      },
    }),
  );
  if (!outcome.ok) {
    throw new Error('restrictedGrant: grant was refused');
  }
  return outcome.grantId;
}

const start = (client: TestClient, betAmount: string) =>
  client.post('/gaming/rounds/start', { gameId, currency: 'USD', betAmount });

async function realBalanceOf(userId: string) {
  const [row] = await drizzle()
    .select({ amount: walletBalance.amount })
    .from(walletBalance)
    .innerJoin(wallet, eq(wallet.id, walletBalance.walletId))
    .where(eq(wallet.userId, userId));
  return Number(row?.amount ?? 'NaN');
}

const grantRow = async (id: string) => {
  const [row] = await drizzle().select().from(promoGrant).where(eq(promoGrant.id, id));
  if (!row) {
    throw new Error('grant row missing');
  }
  return row;
};

const auditCount = async (resourceId: string) => {
  const [row] = await drizzle()
    .select({ total: sql<number>`count(*)::int` })
    .from(auditLog)
    .where(eq(auditLog.resourceId, resourceId));
  return row?.total ?? 0;
};

beforeAll(async () => {
  ({ db, app } = await bootE2e());

  const { client, userId } = await registerAndMaterializePlayer(app, {
    email: `class-hostile-admin-${randomUUID()}@example.test`,
  });
  await drizzle().update(user).set({ role: 'admin' }).where(eq(user.id, userId));
  const [role] = await drizzle().select().from(adminRole).where(eq(adminRole.key, 'super-admin'));
  if (!role) {
    throw new Error('no seeded super-admin role');
  }
  await drizzle()
    .insert(adminRoleAssignment)
    .values({ userId, roleId: role.id })
    .onConflictDoNothing();
  admin = client;

  const [provider] = await drizzle()
    .insert(gameProvider)
    .values({ slug: `class-hostile-${randomUUID()}`, name: 'Class Hostile', isActive: true })
    .returning();
  const [row] = await drizzle()
    .insert(game)
    .values({
      reviewStatus: 'approved',
      name: 'Class Hostile Game',
      slug: `class-hostile-game-${randomUUID()}`,
      providerId: provider!.id,
      aggregator: 'direct',
      isActive: true,
    })
    .returning();
  gameId = row!.id;
  await backfillLedgerGames(drizzle());

  const [profile] = await drizzle()
    .insert(promoWeightProfile)
    .values({ name: `zero-casino-${randomUUID()}` })
    .returning();
  zeroCasinoProfileId = profile!.id;
  await drizzle()
    .insert(promoWeight)
    .values([
      {
        profileId: zeroCasinoProfileId,
        scope: 'product',
        scopeRef: 'casino',
        contributionPercent: '0',
      },
      {
        profileId: zeroCasinoProfileId,
        scope: 'product',
        scopeRef: 'live-casino',
        contributionPercent: '100',
      },
    ]);
}, 60_000);

afterAll(async () => {
  await closeE2e({ app, db });
});

describe('a game round refused for restricted funds', () => {
  it('answers insufficient balance with what the class may use, and writes nothing', async () => {
    const { client, userId } = await player('20');
    const grantId = await restrictedGrant(userId);
    await vi.waitFor(async () => expect(await auditCount(grantId)).toBeGreaterThan(0));
    const auditedBefore = await auditCount(grantId);

    const res = await start(client, '25');

    expect(res.status).toBe(400);
    const body = JSON.stringify(await readJson(res));
    expect(body).toContain('20');
    expect(await realBalanceOf(userId)).toBe(20);
    const row = await grantRow(grantId);
    expect([row.bonusBalance, row.unlinkedCash, row.linkedCash].map(Number)).toEqual([50, 10, 10]);
    expect(
      await drizzle().select().from(promoGrantEntry).where(eq(promoGrantEntry.grantId, grantId)),
    ).toHaveLength(1);
    expect(
      await drizzle().select().from(promoGrantRound).where(eq(promoGrantRound.grantId, grantId)),
    ).toEqual([]);
    expect(await drizzle().select().from(gameRound).where(eq(gameRound.userId, userId))).toEqual(
      [],
    );
    expect(await auditCount(grantId)).toBe(auditedBefore);
  });

  it('then takes the round when the stake is brought down to what was reported', async () => {
    const { client, userId } = await player('20');
    const grantId = await restrictedGrant(userId);

    expect((await start(client, '25')).status).toBe(400);
    expect((await start(client, '20')).status).toBe(200);

    const row = await grantRow(grantId);
    expect([row.bonusBalance, row.unlinkedCash, row.linkedCash].map(Number)).toEqual([50, 0, 0]);
    expect(await realBalanceOf(userId)).toBe(0);
  });

  it('lets only one of two simultaneous rounds draw on the same restricted buckets', async () => {
    for (let i = 0; i < 3; i += 1) {
      const { client, userId } = await player('20');
      const grantId = await restrictedGrant(userId);

      const results = await Promise.all([start(client, '15'), start(client, '15')]);

      expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
      expect(await realBalanceOf(userId)).toBe(5);
      expect(Number((await grantRow(grantId)).bonusBalance)).toBe(50);
    }
  });
});

describe('an admin sending a contribution a profile cannot hold', () => {
  const weights = [{ scope: 'default', scopeRef: null, contributionPercent: '100' }];
  const create = async () =>
    readJson(
      await admin.post('/backoffice/promo/weight-profiles', { name: `hostile-${randomUUID()}` }),
    );

  it('refuses an edge of zero, above one, past 18 places, or beside a flat mode', async () => {
    const created = await create();
    await vi.waitFor(async () => expect(await auditCount(created.id)).toBeGreaterThan(0));
    const auditedBefore = await auditCount(created.id);
    const put = (contribution: Record<string, unknown>) =>
      admin.put(`/backoffice/promo/weight-profiles/${created.id}/weights`, {
        weights,
        ...contribution,
      });

    for (const contribution of [
      { contributionMode: 'house_edge', referenceEdge: '0' },
      { contributionMode: 'house_edge', referenceEdge: '0.000000000000000000' },
      { contributionMode: 'house_edge', referenceEdge: '1.5' },
      { contributionMode: 'house_edge', referenceEdge: '-0.04' },
      { contributionMode: 'house_edge', referenceEdge: '0.1234567890123456789' },
      { contributionMode: 'house_edge', referenceEdge: '4e-2' },
      { contributionMode: 'flat', referenceEdge: '0.04' },
      { referenceEdge: '0.04' },
      { contributionMode: 'martingale' },
    ]) {
      expect((await put(contribution)).status, JSON.stringify(contribution)).toBe(400);
    }

    const listed = await readJson(await admin.get('/backoffice/promo/weight-profiles'));
    const same = listed.find((p: { id: string }) => p.id === created.id);
    expect(same).toMatchObject({ contributionMode: 'flat', version: 1 });
    // The audit outbox keeps order, so a refusal that audited would land before this save.
    expect((await put({ contributionMode: 'house_edge', referenceEdge: '0.04' })).status).toBe(200);
    await vi.waitFor(async () => expect(await auditCount(created.id)).toBe(auditedBefore + 1));
  });

  it('accepts an edge of exactly one and the smallest edge, and counts a version per save', async () => {
    const created = await create();
    const put = (referenceEdge: string) =>
      admin.put(`/backoffice/promo/weight-profiles/${created.id}/weights`, {
        weights,
        contributionMode: 'house_edge',
        referenceEdge,
      });

    expect(await readJson(await put('1'))).toMatchObject({ version: 2 });
    expect(await readJson(await put('0.000000000000000001'))).toMatchObject({ version: 3 });
  });

  it('refuses a caller with no session and a player on the create route, leaving no profile', async () => {
    const name = `nobody-${randomUUID()}`;
    const { client } = await registerAndMaterializePlayer(app, {
      email: `class-hostile-player-${randomUUID()}@example.test`,
    });

    expect(
      (
        await app.app.request('/backoffice/promo/weight-profiles', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name }),
        })
      ).status,
    ).toBe(401);
    expect((await client.post('/backoffice/promo/weight-profiles', { name })).status).toBe(403);
    const listed = await readJson(await admin.get('/backoffice/promo/weight-profiles'));
    expect(listed.some((p: { name: string }) => p.name === name)).toBe(false);
  });
});

describe('an admin naming a bet class or bucket the engine does not know', () => {
  const offer = (betClassBuckets: Record<string, unknown>) => ({
    key: `offer-${randomUUID()}`,
    name: 'Class Rules',
    status: 'active',
    currency: 'USD',
    matchPercent: '100',
    maxGrantAmount: '1000',
    minDeposit: '20',
    terms: {
      wageringMultiplier: '5',
      expiryDays: 30,
      funds: {
        rolloverBase: 'bonus',
        existingBalance: 'free',
        freeFundsOrder: 'first',
        dustThresholdUsd: '0.01',
        decimals: 2,
        betClassBuckets,
      },
    },
    rules: { firstDepositOnly: false, excludedCountries: [] },
    requiresOptIn: true,
  });

  it('refuses an unknown class, an unknown bucket and a repeated bucket', async () => {
    expect(
      (await admin.post('/backoffice/promo/offers', offer({ sportsbook: ['bonus'] }))).status,
    ).toBe(400);
    expect((await admin.post('/backoffice/promo/offers', offer({ zero: ['real'] }))).status).toBe(
      400,
    );
    expect(
      (await admin.post('/backoffice/promo/offers', offer({ zero: ['bonus', 'bonus'] }))).status,
    ).toBe(400);
    expect((await admin.post('/backoffice/promo/offers', offer({ zero: ['bonus'] }))).status).toBe(
      200,
    );
  });
});

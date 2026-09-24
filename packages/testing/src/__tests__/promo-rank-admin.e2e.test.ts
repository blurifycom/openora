import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { loadExtensions, DRIZZLE } from '@openora/core/server';
import { WAGER_TRACKING } from '@openora/core/contracts';
import { user } from '@openora/core/pam/schema/identity';
import { adminRole, adminRoleAssignment } from '@openora/core/iam/schema';
import { auditLog } from '@openora/core/audit/schema';
import { promoRankTier } from '@openora/core/promo/schema/gamification';
import {
  setupTestDb,
  bootTestApp,
  seedMinimal,
  registerAndMaterializePlayer,
  type TestDb,
  type TestApp,
  type TestClient,
} from '../index.js';

let db: TestDb;
let app: TestApp;
let admin: TestClient;
let adminId: string;
let support: TestClient;
let seeded: { currency: string; tiers: ReturnType<typeof editable>[] };

const drizzle = () => app.container.get(DRIZZLE).db;

// oxlint-disable-next-line typescript/no-explicit-any -- ad-hoc JSON shape assertions in tests
async function readJson(res: Response): Promise<any> {
  return res.json();
}

async function adminWithRole(roleKey: string) {
  const { client, userId } = await registerAndMaterializePlayer(app, {
    email: `rank-admin-${randomUUID()}@example.test`,
  });
  await drizzle().update(user).set({ role: 'admin' }).where(eq(user.id, userId));
  const [role] = await drizzle().select().from(adminRole).where(eq(adminRole.key, roleKey));
  if (!role) {
    throw new Error(`no seeded ${roleKey} role`);
  }
  await drizzle()
    .insert(adminRoleAssignment)
    .values({ userId, roleId: role.id })
    .onConflictDoNothing();
  return { client, userId };
}

const ladderRows = () =>
  drizzle()
    .select({
      id: promoRankTier.id,
      key: promoRankTier.key,
      wagerThreshold: promoRankTier.wagerThreshold,
      levelUpBonus: promoRankTier.levelUpBonus,
    })
    .from(promoRankTier)
    .orderBy(promoRankTier.position);

const auditRows = () => drizzle().select().from(auditLog).where(eq(auditLog.action, LADDER_ACTION));

// audit_log is append-only, so a test counts what its own call added rather than clearing rows.
const auditCount = async () => (await auditRows()).length;

const LADDER_ACTION = 'promo.rank_ladder.set';
const SAVED_SILVER_THRESHOLD = '12345.000000000000000000';
const SAVED_GOLD_LEVEL_UP = '200.000000000000000000';
const RAISED_SILVER_THRESHOLD = '20000.000000000000000000';

const editable = (tier: {
  id: string;
  key: string;
  name: string;
  wagerThreshold: string;
  rakebackPercent: string;
  dailyBonus: string | null;
  weeklyBonus: string | null;
  monthlyBonus: string | null;
  levelUpBonus: string | null;
}) => ({
  id: tier.id,
  key: tier.key,
  name: tier.name,
  wagerThreshold: tier.wagerThreshold,
  rakebackPercent: tier.rakebackPercent,
  dailyBonus: tier.dailyBonus,
  weeklyBonus: tier.weeklyBonus,
  monthlyBonus: tier.monthlyBonus,
  levelUpBonus: tier.levelUpBonus,
});

async function currentPayload() {
  const body = await readJson(await admin.get('/backoffice/promo/ranks'));
  return { currency: body.currency, tiers: body.tiers.map(editable) };
}

const recordWager = (userId: string, weightedAmount: string) =>
  drizzle().transaction((tx) =>
    app.container.get(WAGER_TRACKING).recordWager(tx, {
      userId,
      currency: 'USDT',
      amount: weightedAmount,
      weightedAmount,
      context: { provider: 'aggregator', product: 'casino' },
    }),
  );

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['WITHDRAWAL_PIN_HMAC_SECRET'] ??= 'e2e-test-withdrawal-pin-hmac-secret-000000';
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  app = await bootTestApp({ plugins: await loadExtensions(), databaseUrl: db.url });
  await seedMinimal(app.container, { playerCount: 0 });

  const promotions = await adminWithRole('bonus-promotions');
  admin = promotions.client;
  adminId = promotions.userId;
  support = (await adminWithRole('customer-support-agent')).client;
  seeded = await currentPayload();
}, 60_000);

afterAll(async () => {
  await app.close();
  await db.dispose();
});

// The ladder is shared reference data in one test database, so a file that edits it hands the
// next file a ladder it never seeded.
afterEach(async () => {
  await admin.put('/backoffice/promo/ranks', seeded);
});

describe('an operator configuring the rank ladder', () => {
  it('reads the seeded ladder', async () => {
    const res = await admin.get('/backoffice/promo/ranks');
    const body = await readJson(res);

    expect(res.status).toBe(200);
    expect(body.currency).toBe('USDT');
    expect(body.tiers).toHaveLength(seeded.tiers.length);
    expect(body.tiers[0]).toMatchObject({ key: 'bronze', position: 0 });
  });

  it('saves new values, shows them to the player and records one audit row', async () => {
    const auditedBefore = await auditCount();
    const payload = await currentPayload();
    const silver = payload.tiers[1];
    const gold = payload.tiers[2];
    const { client } = await registerAndMaterializePlayer(app, {
      email: `rank-reader-${randomUUID()}@example.test`,
    });

    const res = await admin.put('/backoffice/promo/ranks', {
      currency: payload.currency,
      tiers: payload.tiers.map((tier: { id: string }) =>
        tier.id === silver.id
          ? { ...tier, wagerThreshold: '12345' }
          : tier.id === gold.id
            ? { ...tier, levelUpBonus: '200' }
            : tier,
      ),
    });
    const body = await readJson(res);
    const seenByPlayer = await readJson(await client.get('/promo/ranks'));

    expect(res.status).toBe(200);
    expect(body.tiers[1]).toMatchObject({ key: 'silver', wagerThreshold: SAVED_SILVER_THRESHOLD });
    expect(seenByPlayer.tiers[1].wagerThreshold).toBe(SAVED_SILVER_THRESHOLD);
    expect(seenByPlayer.tiers[2].levelUpBonus).toBe(SAVED_GOLD_LEVEL_UP);

    const rows = await auditRows();
    expect(rows).toHaveLength(auditedBefore + 1);
    expect(rows.at(-1)).toMatchObject({
      actorId: adminId,
      actorType: 'admin',
      resourceType: 'promo_rank_tier',
    });
    expect(rows.at(-1)?.before).toMatchObject({ tiers: expect.any(Array) });
    expect(rows.at(-1)?.after).toMatchObject({ tiers: expect.any(Array) });
  });

  it('refuses thresholds that stop increasing and changes nothing', async () => {
    const auditedBefore = await auditCount();
    const payload = await currentPayload();
    const before = await ladderRows();

    const res = await admin.put('/backoffice/promo/ranks', {
      currency: payload.currency,
      tiers: payload.tiers.map((tier: { position?: number }, index: number) =>
        index === 2 ? { ...tier, wagerThreshold: '1' } : tier,
      ),
    });

    expect(res.status).toBe(400);
    expect(await ladderRows()).toEqual(before);
    expect(await auditCount()).toBe(auditedBefore);
  });

  it('refuses a lowest tier that does not start at zero', async () => {
    const auditedBefore = await auditCount();
    const payload = await currentPayload();

    const res = await admin.put('/backoffice/promo/ranks', {
      currency: payload.currency,
      tiers: payload.tiers.map((tier: unknown, index: number) =>
        index === 0 ? { ...(tier as object), wagerThreshold: '10' } : tier,
      ),
    });

    expect(res.status).toBe(400);
    expect(await auditCount()).toBe(auditedBefore);
  });

  it('adds a tier, renames another and keeps them in the order they were sent', async () => {
    const auditedBefore = await auditCount();
    const payload = await currentPayload();
    const renamed = { ...payload.tiers[0], name: 'Starter' };
    const added = {
      key: `diamond-${randomUUID().slice(0, 8)}`,
      name: 'Diamond',
      wagerThreshold: '9000000',
      rakebackPercent: '12',
      dailyBonus: null,
      weeklyBonus: null,
      monthlyBonus: null,
      levelUpBonus: null,
    };

    const res = await admin.put('/backoffice/promo/ranks', {
      currency: payload.currency,
      tiers: [renamed, ...payload.tiers.slice(1), added],
    });
    const body = await readJson(res);

    expect(res.status).toBe(200);
    expect(body.tiers).toHaveLength(payload.tiers.length + 1);
    expect(body.tiers[0]).toMatchObject({ name: 'Starter', position: 0 });
    expect(body.tiers.at(-1)).toMatchObject({ key: added.key, position: payload.tiers.length });
    expect(await auditCount()).toBe(auditedBefore + 1);
  });

  it('removes a tier nobody holds', async () => {
    const payload = await currentPayload();

    const res = await admin.put('/backoffice/promo/ranks', {
      currency: payload.currency,
      tiers: payload.tiers.slice(0, -1),
    });
    const body = await readJson(res);

    expect(res.status).toBe(200);
    expect(body.tiers).toHaveLength(payload.tiers.length - 1);
  });

  it('refuses to remove a tier a player holds', async () => {
    const auditedBefore = await auditCount();
    const { userId } = await registerAndMaterializePlayer(app, {
      email: `rank-holder-${randomUUID()}@example.test`,
    });
    await recordWager(userId, '12000');
    const payload = await currentPayload();

    const res = await admin.put('/backoffice/promo/ranks', {
      currency: payload.currency,
      tiers: payload.tiers.filter((_: unknown, index: number) => index !== 1),
    });

    expect(res.status).toBe(409);
    expect(await auditCount()).toBe(auditedBefore);
  });

  it('refuses to change the currency once a player has wagered', async () => {
    const auditedBefore = await auditCount();
    const { userId } = await registerAndMaterializePlayer(app, {
      email: `rank-wagered-${randomUUID()}@example.test`,
    });
    await recordWager(userId, '1');
    const payload = await currentPayload();

    const res = await admin.put('/backoffice/promo/ranks', { ...payload, currency: 'EUR' });

    expect(res.status).toBe(409);
    expect(await auditCount()).toBe(auditedBefore);
  });

  it('refuses a set naming a tier the ladder does not hold', async () => {
    const auditedBefore = await auditCount();
    const payload = await currentPayload();

    const res = await admin.put('/backoffice/promo/ranks', {
      currency: payload.currency,
      tiers: [...payload.tiers.slice(0, -1), { ...payload.tiers.at(-1), id: randomUUID() }],
    });

    expect(res.status).toBe(400);
    expect(await auditCount()).toBe(auditedBefore);
  });

  it('lets a read-only admin look but not save', async () => {
    const auditedBefore = await auditCount();
    const payload = await currentPayload();

    expect((await support.get('/backoffice/promo/ranks')).status).toBe(200);
    expect((await support.put('/backoffice/promo/ranks', payload)).status).toBe(403);
    expect(await auditCount()).toBe(auditedBefore);
  });

  it('refuses a player on both routes and an anonymous caller outright', async () => {
    const auditedBefore = await auditCount();
    const { client } = await registerAndMaterializePlayer(app, {
      email: `rank-nosy-${randomUUID()}@example.test`,
    });

    expect((await client.get('/backoffice/promo/ranks')).status).toBe(403);
    expect((await client.put('/backoffice/promo/ranks', seeded)).status).toBe(403);
    expect((await app.app.request('/backoffice/promo/ranks')).status).toBe(401);
    expect(await auditCount()).toBe(auditedBefore);
  });

  it('does not demote a player when their tier is raised above what they wagered', async () => {
    const { client, userId } = await registerAndMaterializePlayer(app, {
      email: `rank-holder-${randomUUID()}@example.test`,
    });
    await drizzle().transaction((tx) =>
      app.container.get(WAGER_TRACKING).recordWager(tx, {
        userId,
        currency: 'USDT',
        amount: '15000',
        weightedAmount: '15000',
        context: { provider: 'aggregator', product: 'casino' },
      }),
    );
    const before = await readJson(await client.get('/promo/ranks'));
    const payload = await currentPayload();

    await admin.put('/backoffice/promo/ranks', {
      currency: payload.currency,
      tiers: payload.tiers.map((tier: { id: string }, index: number) =>
        index === 1 ? { ...tier, wagerThreshold: '20000' } : tier,
      ),
    });
    const after = await readJson(await client.get('/promo/ranks'));

    expect(before.tierId).toBe(after.tierId);
    expect(after.tiers[1].wagerThreshold).toBe(RAISED_SILVER_THRESHOLD);
  });
});

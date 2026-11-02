import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '@openora/core/server';
import { WAGER_TRACKING, type WagerProduct } from '@openora/core/contracts';
import { user } from '@openora/core/pam/schema/identity';
import { adminRole, adminRoleAssignment } from '@openora/core/iam/schema';
import { auditLog } from '@openora/core/audit/schema';
import {
  registerAndMaterializePlayer,
  type TestDb,
  type TestApp,
  type TestClient,
  bootE2e,
  closeE2e,
  readJson,
} from '../index.js';
import { EXAMPLE_RANK_LADDER } from '../seed.js';

let db: TestDb;
let app: TestApp;
let admin: TestClient;
let support: TestClient;

const drizzle = () => app.container.get(DRIZZLE).db;

const CONFIG_ACTION = 'promo.rank_config.set';
const CONFIG_PATH = '/backoffice/promo/ranks/config';
const CASINO_ONLY = {
  payoutCurrency: 'USDT',
  payInPlayerCurrency: true,
  periodicRequiresActivity: false,
  periodicMinimumWager: '25.000000000000000000',
  payoutAnchors: { dailyHour: 6, weeklyDay: 5, monthlyDay: 15 },
  eligibleProducts: ['casino'],
  rakebackEligibleProducts: ['casino'],
  rankChallengeEligibleProducts: ['casino', 'sportsbook'],
  rewards: {
    levelUp: { wageringMultiplier: '5', expiryDays: 14 },
    daily: { wageringMultiplier: '1', expiryDays: 1 },
  },
};

const SEEDED = {
  ...EXAMPLE_RANK_LADDER.config,
  payoutCurrency: null,
  periodicMinimumWager: null,
};

async function adminWithRole(roleKey: string) {
  const { client, userId } = await registerAndMaterializePlayer(app, {
    email: `rank-config-${randomUUID()}@example.test`,
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
  return client;
}

// audit_log is append-only, so a test counts what its own call added rather than clearing rows.
const auditRows = () => drizzle().select().from(auditLog).where(eq(auditLog.action, CONFIG_ACTION));

const wager = (userId: string, amount: string, product: WagerProduct) =>
  drizzle().transaction((tx) =>
    app.container.get(WAGER_TRACKING).recordWager(tx, {
      userId,
      currency: 'USDT',
      amount,
      weightedAmount: amount,
      realAmount: amount,
      context: { provider: 'aggregator', product },
    }),
  );

beforeAll(async () => {
  ({ db, app } = await bootE2e());

  admin = await adminWithRole('bonus-promotions');
  support = await adminWithRole('customer-support-agent');
}, 60_000);

afterAll(async () => {
  await closeE2e({ app, db });
});

// The settings are shared reference data in one test database; hand the next test what it seeded.
afterEach(async () => {
  await admin.put(CONFIG_PATH, EXAMPLE_RANK_LADDER.config);
});

describe('an operator configuring what a rank counts and pays', () => {
  it('reads the seeded settings', async () => {
    const res = await admin.get(CONFIG_PATH);

    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual(SEEDED);
  });

  it('saves new settings, audits them, and stops counting products left out', async () => {
    const auditedBefore = (await auditRows()).length;
    const { client, userId } = await registerAndMaterializePlayer(app, {
      email: `rank-config-player-${randomUUID()}@example.test`,
    });

    const res = await admin.put(CONFIG_PATH, CASINO_ONLY);
    await wager(userId, '40', 'sportsbook');
    await wager(userId, '60', 'casino');

    expect(res.status).toBe(200);
    expect(await readJson(await admin.get(CONFIG_PATH))).toEqual(CASINO_ONLY);
    expect((await readJson(await client.get('/promo/ranks'))).lifetimeWagered).toBe(
      '60.000000000000000000',
    );
    const audited = await auditRows();
    expect(audited).toHaveLength(auditedBefore + 1);
    expect(audited.at(-1)).toMatchObject({ actorType: 'admin', after: CASINO_ONLY });
  });

  it('keeps the stored product lists and minimum wager when a save leaves them out', async () => {
    const {
      rakebackEligibleProducts: _r,
      rankChallengeEligibleProducts: _c,
      periodicMinimumWager: _m,
      ...older
    } = CASINO_ONLY;
    await admin.put(CONFIG_PATH, CASINO_ONLY);

    const res = await admin.put(CONFIG_PATH, { ...older, eligibleProducts: ['casino', 'pvp'] });

    expect(res.status).toBe(200);
    const kept = {
      eligibleProducts: ['casino', 'pvp'],
      rakebackEligibleProducts: CASINO_ONLY.rakebackEligibleProducts,
      rankChallengeEligibleProducts: CASINO_ONLY.rankChallengeEligibleProducts,
      periodicMinimumWager: CASINO_ONLY.periodicMinimumWager,
    };
    expect(await readJson(res)).toMatchObject(kept);
    expect(await readJson(await admin.get(CONFIG_PATH))).toMatchObject(kept);
    expect((await auditRows()).at(-1)).toMatchObject({ after: kept });
  });

  it('clears the minimum wager only on an explicit null', async () => {
    await admin.put(CONFIG_PATH, CASINO_ONLY);

    const res = await admin.put(CONFIG_PATH, { ...CASINO_ONLY, periodicMinimumWager: null });

    expect(res.status).toBe(200);
    expect(await readJson(await admin.get(CONFIG_PATH))).toMatchObject({
      periodicMinimumWager: null,
    });
  });

  it('refuses a product list naming a product the platform does not have, changing nothing', async () => {
    const auditedBefore = (await auditRows()).length;

    const res = await admin.put(CONFIG_PATH, {
      ...CASINO_ONLY,
      rakebackEligibleProducts: ['casino', 'poker'],
    });

    expect(res.status).toBe(400);
    expect(await readJson(await admin.get(CONFIG_PATH))).toEqual(SEEDED);
    expect(await auditRows()).toHaveLength(auditedBefore);
  });

  it('refuses a wagering multiplier the bonus engine would reject, changing nothing', async () => {
    const auditedBefore = (await auditRows()).length;

    const res = await admin.put(CONFIG_PATH, {
      eligibleProducts: [],
      rewards: { daily: { wageringMultiplier: '1000.01', expiryDays: 1 } },
      payoutAnchors: EXAMPLE_RANK_LADDER.config.payoutAnchors,
    });

    expect(res.status).toBe(400);
    expect(await readJson(await admin.get(CONFIG_PATH))).toEqual(SEEDED);
    expect(await auditRows()).toHaveLength(auditedBefore);
  });

  it('lets a read-only admin look but not save, and refuses a player and an anonymous caller', async () => {
    const auditedBefore = (await auditRows()).length;
    const { client } = await registerAndMaterializePlayer(app, {
      email: `rank-config-nosy-${randomUUID()}@example.test`,
    });

    expect((await support.get(CONFIG_PATH)).status).toBe(200);
    expect((await support.put(CONFIG_PATH, CASINO_ONLY)).status).toBe(403);
    expect((await client.get(CONFIG_PATH)).status).toBe(403);
    expect((await client.put(CONFIG_PATH, CASINO_ONLY)).status).toBe(403);
    expect((await app.app.request(CONFIG_PATH)).status).toBe(401);
    expect(await auditRows()).toHaveLength(auditedBefore);
  });
});

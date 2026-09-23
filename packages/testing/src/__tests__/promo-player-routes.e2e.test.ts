import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { loadExtensions, DRIZZLE, EVENT_BUS } from '@openora/core/server';
import { BONUS_GRANTS } from '@openora/core/contracts';
import { promoWeight, promoWeightProfile } from '@openora/core/promo/schema/bonus';
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
let weightProfileId: string;

const drizzle = () => app.container.get(DRIZZLE).db;

// oxlint-disable-next-line typescript/no-explicit-any -- ad-hoc JSON shape assertions in tests
async function readJson(res: Response): Promise<any> {
  return res.json();
}

async function grantBonus(userId: string, amount: string) {
  const outcome = await drizzle().transaction((tx) =>
    app.container.get(BONUS_GRANTS).grant(tx, {
      userId,
      currency: 'USD',
      amount,
      source: 'deposit',
      sourceRef: randomUUID(),
      actor: { type: 'system' },
      terms: { wageringMultiplier: '5', expiryDays: 30, weightProfileId },
    }),
  );
  if (!outcome.ok) {
    throw new Error('grantBonus: grant was refused');
  }
  return outcome.grantId;
}

async function player(): Promise<{ client: TestClient; userId: string }> {
  return registerAndMaterializePlayer(app, { email: `grants-${randomUUID()}@example.test` });
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

  const [profile] = await drizzle()
    .insert(promoWeightProfile)
    .values({ name: `routes-${randomUUID()}` })
    .returning();
  if (!profile) {
    throw new Error('seed profile: query returned no row');
  }
  weightProfileId = profile.id;
  await drizzle().insert(promoWeight).values({
    profileId: weightProfileId,
    scope: 'default',
    scopeRef: null,
    contributionPercent: '100',
  });
}, 60_000);

afterAll(async () => {
  await app.close();
  await db.dispose();
});

describe('a player reading their own bonuses', () => {
  it('lists them with the money as strings', async () => {
    const { client, userId } = await player();
    const grantId = await grantBonus(userId, '120');

    const body = await readJson(await client.get('/promo/grants'));

    expect(body.items).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.items[0]).toMatchObject({
      id: grantId,
      currency: 'USD',
      status: 'active',
      grantedAmount: '120.000000000000000000',
      wageringRequired: '600.000000000000000000',
    });
    expect(typeof body.items[0].bonusBalance).toBe('string');
  });

  it('returns an empty list for a player who holds none', async () => {
    const { client } = await player();

    const res = await client.get('/promo/grants');

    expect(res.status).toBe(200);
    expect(await readJson(res)).toMatchObject({ items: [], total: 0 });
  });

  it('filters by status', async () => {
    const { client, userId } = await player();
    await grantBonus(userId, '30');

    const active = await readJson(await client.get('/promo/grants?status=active'));
    const expired = await readJson(await client.get('/promo/grants?status=expired'));

    expect(active.items).toHaveLength(1);
    expect(expired.items).toEqual([]);
    expect(expired.total).toBe(0);
  });

  it('reads one by id', async () => {
    const { client, userId } = await player();
    const grantId = await grantBonus(userId, '45');

    const body = await readJson(await client.get(`/promo/grants/${grantId}`));

    expect(body).toMatchObject({ id: grantId, grantedAmount: '45.000000000000000000' });
  });
});

describe('a player reaching for someone else', () => {
  it('cannot read another player’s grant, and is told it does not exist', async () => {
    const owner = await player();
    const stranger = await player();
    const grantId = await grantBonus(owner.userId, '777.123456');

    const res = await stranger.client.get(`/promo/grants/${grantId}`);

    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('777.123456');
  });

  it('caps a page at the contract limit rather than returning the whole history', async () => {
    const { client, userId } = await player();
    await grantBonus(userId, '10');
    await grantBonus(userId, '20');

    const firstPage = await readJson(await client.get('/promo/grants?limit=1'));
    const secondPage = await readJson(await client.get('/promo/grants?limit=1&page=2'));

    expect(firstPage.items).toHaveLength(1);
    expect(secondPage.items).toHaveLength(1);
    // The count is what tells a client there is a second page at all.
    expect(firstPage.total).toBe(2);
    expect(firstPage.items[0].id).not.toBe(secondPage.items[0].id);
  });

  it('cannot widen the list past their own grants', async () => {
    const owner = await player();
    const stranger = await player();
    await grantBonus(owner.userId, '90');

    const body = await readJson(await stranger.client.get(`/promo/grants?userId=${owner.userId}`));

    expect(body).toMatchObject({ items: [], total: 0 });
  });

  it('is refused outright when signed out', async () => {
    const res = await app.app.request('/promo/grants');

    expect(res.status).toBe(401);
  });
});

describe('self-exclusion forfeiting every active grant', () => {
  it('forfeits immediately and records the system as the actor, not an admin', async () => {
    const { userId } = await player();
    const grantId = await grantBonus(userId, '50');

    // A system-triggered exclusion (a rule, not a person) is not an admin action. Emitted
    // directly, the same technique tag.e2e.test.ts uses to drive an event handler without a
    // route to trigger it from.
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
      const grantRes = await admin.get(
        `/audit/logs?resourceId=${grantId}&action=promo.bonus.forfeited`,
      );
      const grantBody = await readJson(grantRes);
      expect(grantBody.items).toHaveLength(1);
      expect(grantBody.items[0].actorType).toBe('system');
      expect(grantBody.items[0].actorId).toBeNull();
    }, JOB_WAIT);
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { loadExtensions, DRIZZLE } from '@openora/core/server';
import { BONUS_GRANTS } from '@openora/core/contracts';
import { user } from '@openora/core/pam/schema/identity';
import { adminRole, adminRoleAssignment } from '@openora/core/iam/schema';
import { auditLog } from '@openora/core/audit/schema';
import { promoGrant, promoWeight, promoWeightProfile } from '@openora/core/promo/schema/bonus';
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
      source: 'manual',
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

const forfeitRows = () =>
  drizzle().select().from(auditLog).where(eq(auditLog.action, 'promo.bonus.forfeited'));

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['WITHDRAWAL_PIN_HMAC_SECRET'] ??= 'e2e-test-withdrawal-pin-hmac-secret-000000';
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  app = await bootTestApp({ plugins: await loadExtensions(), databaseUrl: db.url });
  await seedMinimal(app.container, { playerCount: 0 });

  const { client, userId } = await registerAndMaterializePlayer(app, {
    email: `admin-grants-${randomUUID()}@example.test`,
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

  const [profile] = await drizzle()
    .insert(promoWeightProfile)
    .values({ name: `admin-grants-${randomUUID()}` })
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

describe('support looking at a player', () => {
  it('reads their bonuses, with the source a player never sees', async () => {
    const { userId } = await registerAndMaterializePlayer(app, {
      email: `subject-${randomUUID()}@example.test`,
    });
    const grantId = await grantBonus(userId, '80');

    const body = await readJson(await admin.get(`/backoffice/promo/players/${userId}/grants`));

    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ id: grantId, userId, source: 'manual', status: 'active' });
    expect(typeof body[0].sourceRef).toBe('string');
  });

  it('refuses a player reaching for it', async () => {
    const { client, userId } = await registerAndMaterializePlayer(app, {
      email: `nosy-${randomUUID()}@example.test`,
    });

    const res = await client.get(`/backoffice/promo/players/${userId}/grants`);

    expect(res.status).toBe(403);
  });
});

describe('support forfeiting a bonus', () => {
  it('voids the balance and records who did it and why', async () => {
    const { userId } = await registerAndMaterializePlayer(app, {
      email: `forfeit-${randomUUID()}@example.test`,
    });
    const grantId = await grantBonus(userId, '120');

    const body = await readJson(
      await admin.post(`/backoffice/promo/grants/${grantId}/forfeit`, {
        reason: 'admin',
        note: 'Charge-back investigation 4821',
      }),
    );

    expect(body).toMatchObject({
      id: grantId,
      status: 'forfeited',
      forfeitReason: 'admin',
      bonusBalance: '0.000000000000000000',
    });
    const audited = await forfeitRows();
    expect(audited).toHaveLength(1);
    expect(audited[0]?.actorType).toBe('admin');
    expect(JSON.stringify(audited[0]?.after)).toContain('Charge-back investigation 4821');
  });

  it('refuses a forfeit with no reason worth recording', async () => {
    const { userId } = await registerAndMaterializePlayer(app, {
      email: `forfeit-bare-${randomUUID()}@example.test`,
    });
    const grantId = await grantBonus(userId, '40');

    const res = await admin.post(`/backoffice/promo/grants/${grantId}/forfeit`, {
      reason: 'admin',
      note: '   ',
    });

    expect(res.status).toBe(400);
    const [row] = await drizzle().select().from(promoGrant).where(eq(promoGrant.id, grantId));
    expect(row?.status).toBe('active');
  });

  it('refuses to forfeit a bonus that is already gone, rather than saying it worked', async () => {
    const { userId } = await registerAndMaterializePlayer(app, {
      email: `forfeit-twice-${randomUUID()}@example.test`,
    });
    const grantId = await grantBonus(userId, '40');
    const body = { reason: 'admin', note: 'First forfeit, recorded properly' };
    await admin.post(`/backoffice/promo/grants/${grantId}/forfeit`, body);

    const res = await admin.post(`/backoffice/promo/grants/${grantId}/forfeit`, body);

    expect(res.status).toBe(409);
  });

  it('tells an admin a grant does not exist rather than that it was already forfeited', async () => {
    const res = await admin.post(`/backoffice/promo/grants/${randomUUID()}/forfeit`, {
      reason: 'admin',
      note: 'Typed the wrong identifier entirely',
    });

    expect(res.status).toBe(404);
  });

  it('leaves a record of a forfeit that took nothing', async () => {
    const before = (await forfeitRows()).length;

    await admin.post(`/backoffice/promo/grants/${randomUUID()}/forfeit`, {
      reason: 'admin',
      note: 'Probing an identifier that is not there',
    });

    const after = await forfeitRows();
    expect(after.length).toBe(before + 1);
    expect(JSON.stringify(after.at(-1)?.after)).toContain('refused');
  });

  it('refuses a player forfeiting anything', async () => {
    const { client, userId } = await registerAndMaterializePlayer(app, {
      email: `forfeit-player-${randomUUID()}@example.test`,
    });
    const grantId = await grantBonus(userId, '40');

    const res = await client.post(`/backoffice/promo/grants/${grantId}/forfeit`, {
      reason: 'admin',
      note: 'Trying it on from a player session',
    });

    expect(res.status).toBe(403);
    const [row] = await drizzle().select().from(promoGrant).where(eq(promoGrant.id, grantId));
    expect(row?.status).toBe('active');
  });
});

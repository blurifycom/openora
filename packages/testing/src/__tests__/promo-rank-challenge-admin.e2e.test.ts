import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { loadExtensions, DRIZZLE } from '@openora/core/server';
import { user } from '@openora/core/pam/schema/identity';
import { adminRole, adminRoleAssignment } from '@openora/core/iam/schema';
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
let otherAdmin: TestClient;
let support: TestClient;

const LADDER_PATH = '/backoffice/promo/rank-challenge';

const tier = (key: string, position: number) => ({
  key,
  name: key,
  position,
  wagerThreshold: String(position * 1000),
  cashAmount: '50',
  physicalItem: null,
});

type Ladder = { version: string; currency: string; tiers: Array<{ id: string; key: string }> };

async function readLadder(client: TestClient): Promise<Ladder> {
  const res = await client.get(LADDER_PATH);
  expect(res.status).toBe(200);
  return (await res.json()) as Ladder;
}

async function adminWithRole(roleKey: string) {
  const { client, userId } = await registerAndMaterializePlayer(app, {
    email: `rank-challenge-admin-${randomUUID()}@example.test`,
  });
  const drizzle = app.container.get(DRIZZLE).db;
  await drizzle.update(user).set({ role: 'admin' }).where(eq(user.id, userId));
  const [role] = await drizzle.select().from(adminRole).where(eq(adminRole.key, roleKey));
  if (!role) {
    throw new Error(`no seeded ${roleKey} role`);
  }
  await drizzle
    .insert(adminRoleAssignment)
    .values({ userId, roleId: role.id })
    .onConflictDoNothing();
  return client;
}

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['WITHDRAWAL_PIN_HMAC_SECRET'] ??= 'e2e-test-withdrawal-pin-hmac-secret-000000';
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  app = await bootTestApp({ plugins: await loadExtensions(), databaseUrl: db.url });
  await seedMinimal(app.container, { playerCount: 0 });

  admin = await adminWithRole('bonus-promotions');
  otherAdmin = await adminWithRole('bonus-promotions');
  support = await adminWithRole('customer-support-agent');
}, 60_000);

afterAll(async () => {
  await app.close();
  await db.dispose();
});

describe('two admins editing the rank challenge ladder', () => {
  it('refuses a save built on a ladder another admin changed, keeping their tier', async () => {
    const initial = await readLadder(admin);
    const seeded = await admin.put(LADDER_PATH, {
      version: initial.version,
      currency: 'USDT',
      tiers: [tier('bronze', 0)],
    });
    expect(seeded.status).toBe(200);
    const loadedByBoth = (await seeded.json()) as Ladder;
    expect(loadedByBoth.version).not.toBe(initial.version);

    const added = await otherAdmin.put(LADDER_PATH, {
      version: loadedByBoth.version,
      currency: 'USDT',
      tiers: [
        ...loadedByBoth.tiers.map((t) => ({ ...tier('bronze', 0), id: t.id })),
        tier('silver', 1),
      ],
    });
    expect(added.status).toBe(200);

    const stale = await admin.put(LADDER_PATH, {
      version: loadedByBoth.version,
      currency: 'USDT',
      tiers: loadedByBoth.tiers.map((t) => ({ ...tier('bronze', 0), id: t.id, name: 'Renamed' })),
    });

    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ data: { reason: 'stale_version' } });
    const current = await readLadder(admin);
    expect(current.tiers.map((t) => t.key)).toEqual(['bronze', 'silver']);
  });

  it('lets a read-only admin look but not save', async () => {
    const { version } = await readLadder(support);

    const res = await support.put(LADDER_PATH, {
      version,
      currency: 'USDT',
      tiers: [tier('bronze', 0)],
    });

    expect(res.status).toBe(403);
  });
});

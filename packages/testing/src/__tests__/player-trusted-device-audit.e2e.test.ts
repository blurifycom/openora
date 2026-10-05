import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { DRIZZLE, loadExtensions } from '@openora/core/server';
import { adminTrustedDevice, user } from '@openora/core/pam/schema/identity';
import {
  asAdmin,
  bootTestApp,
  registerAndMaterializePlayer,
  seedMinimal,
  setupTestDb,
  type TestApp,
  type TestClient,
  type TestDb,
} from '../index.js';

type AuditItem = {
  action: string;
  actorType: string;
  actorId: string | null;
  resourceType: string;
  resourceId: string | null;
  after: Record<string, unknown>;
};

let db: TestDb;
let testApp: TestApp;
let admin: TestClient;
let adminUserId: string;

async function seedTrustedDevice(userId: string): Promise<string> {
  const [row] = await testApp.container
    .get(DRIZZLE)
    .db.insert(adminTrustedDevice)
    .values({
      userId,
      deviceHash: randomUUID(),
      label: 'Chrome on Windows',
      expiresAt: new Date(Date.now() + 86_400_000),
    })
    .returning({ id: adminTrustedDevice.id });
  if (!row) {
    throw new Error('trusted device not seeded');
  }
  return row.id;
}

async function deviceRevocations(playerId: string): Promise<AuditItem[]> {
  const res = await admin.get(
    `/audit/logs?resourceType=player&resourceId=${playerId}&action=identity.trusted_device.revoked`,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: AuditItem[] };
  return body.items;
}

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['WITHDRAWAL_PIN_HMAC_SECRET'] ??= 'e2e-test-withdrawal-pin-hmac-secret-000000';
  process.env['NODE_ENV'] ??= 'test';
  db = await setupTestDb();
  testApp = await bootTestApp({ plugins: await loadExtensions(), databaseUrl: db.url });
  await seedMinimal(testApp.container, { playerCount: 0 });
  admin = await asAdmin(testApp.app);
  const [account] = await testApp.container
    .get(DRIZZLE)
    .db.select({ id: user.id })
    .from(user)
    .where(eq(user.email, 'admin@oss.dev'));
  if (!account) {
    throw new Error('no seeded admin account');
  }
  adminUserId = account.id;
}, 60_000);

afterAll(async () => {
  await testApp?.close();
  await db?.dispose();
});

describe('player trusted device audit', () => {
  it("files a Super Admin revoke of a player's trusted device under the player", async () => {
    const { userId, playerId } = await registerAndMaterializePlayer(testApp, {
      email: `trusted-device-audit-${randomUUID()}@e2e.test`,
    });
    const deviceId = await seedTrustedDevice(userId);

    const res = await admin.post('/identity/admin-security/trusted-devices/revoke-for-user', {
      userId,
      id: deviceId,
    });
    expect(res.status).toBe(200);

    await vi.waitFor(async () => {
      expect(await deviceRevocations(playerId)).toEqual([
        expect.objectContaining({
          actorType: 'admin',
          actorId: adminUserId,
          resourceType: 'player',
          resourceId: playerId,
          after: expect.objectContaining({ deviceId, playerId }),
        }),
      ]);
    });
  });

  it("refuses a player revoking another account's trusted device and records nothing", async () => {
    const victim = await registerAndMaterializePlayer(testApp, {
      email: `trusted-device-victim-${randomUUID()}@e2e.test`,
    });
    const attacker = await registerAndMaterializePlayer(testApp, {
      email: `trusted-device-attacker-${randomUUID()}@e2e.test`,
    });
    const deviceId = await seedTrustedDevice(victim.userId);

    const res = await attacker.client.post(
      '/identity/admin-security/trusted-devices/revoke-for-user',
      { userId: victim.userId, id: deviceId },
    );
    expect(res.status).toBe(403);

    const [device] = await testApp.container
      .get(DRIZZLE)
      .db.select({ revokedAt: adminTrustedDevice.revokedAt })
      .from(adminTrustedDevice)
      .where(eq(adminTrustedDevice.id, deviceId));
    expect(device?.revokedAt).toBeNull();
    expect(await deviceRevocations(victim.playerId)).toEqual([]);
  });
});

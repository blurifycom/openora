import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { ADMIN_GUARD, DRIZZLE } from '@openora/core/server';
import { auditLog } from '@openora/core/audit/schema';
import { user } from '@openora/core/pam/schema/identity';
import {
  asAdmin,
  assignIamRoleByKey,
  bootE2e,
  closeE2e,
  registerAndMaterializePlayer,
  type TestApp,
  type TestClient,
  type TestDb,
} from '../index.js';

type Account = { userId: string; playerId: string };

let db: TestDb;
let testApp: TestApp;
let admin: TestClient;

const drizzle = () => testApp.container.get(DRIZZLE).db;

async function newPlayer(): Promise<Account> {
  return registerAndMaterializePlayer(testApp, { email: `id-case-${randomUUID()}@e2e.test` });
}

async function newStaff(roleKey: string): Promise<Account> {
  const account = await newPlayer();
  await assignIamRoleByKey(testApp.container, account.userId, roleKey);
  return account;
}

const setManager = (playerId: string, accountManagerId: string) =>
  admin.put(`/players/${playerId}/account-manager`, { accountManagerId });

const auditCount = async (playerId: string) =>
  (
    await drizzle()
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'admin.player.account_manager_changed'),
          eq(auditLog.resourceId, playerId),
        ),
      )
  ).length;

beforeAll(async () => {
  ({ db, app: testApp } = await bootE2e());
  admin = await asAdmin(testApp.app);
}, 60_000);

afterAll(async () => {
  await closeE2e({ app: testApp, db });
});

describe('account-manager ids in another letter case', () => {
  it('assigns an eligible manager sent in mixed letter case, stored lowercase', async () => {
    const p = await newPlayer();
    const manager = await newStaff('vip-manager');
    const mixed = [...manager.userId].map((c, i) => (i % 2 ? c.toUpperCase() : c)).join('');

    const res = await setManager(p.playerId, mixed);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({ accountManager: { userId: manager.userId } });
  });

  it('refuses an uppercase id with the lowercase reason and denies it under the lowercase user id', async () => {
    const p = await newPlayer();
    const noView = await newStaff('marketing-banners');
    const playerAccount = await newPlayer();
    const inactive = await newStaff('vip-manager');
    await drizzle().update(user).set({ isActive: false }).where(eq(user.id, inactive.userId));

    const refusals = [
      [noView.userId, 'not_eligible'],
      [playerAccount.userId, 'not_eligible'],
      [inactive.userId, 'inactive'],
      [randomUUID(), 'unknown'],
    ] as const;
    for (const [id, reason] of refusals) {
      const lower = await setManager(p.playerId, id);
      const upper = await setManager(p.playerId, id.toUpperCase());
      expect([lower.status, upper.status], reason).toEqual([422, 422]);
      expect(await upper.json()).toMatchObject({ data: { reason } });
      expect(await lower.json()).toMatchObject({ data: { reason } });
    }
    expect(await auditCount(p.playerId)).toBe(0);
    const row = await admin.get(`/players/${p.playerId}`);
    expect(await row.json()).toMatchObject({ accountManager: null });

    const guard = testApp.container.get(ADMIN_GUARD);
    await expect(
      guard.assertUser(noView.userId.toUpperCase(), 'player', 'view'),
    ).rejects.toMatchObject({
      status: 403,
      data: { reason: 'permission_denied', resource: 'player', action: 'view' },
    });
    await vi.waitFor(
      async () => {
        const denials = await drizzle()
          .select({ actorId: auditLog.actorId })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.action, 'identity.user.unauthorized_access'),
              eq(auditLog.actorId, noView.userId),
              eq(auditLog.resourceId, 'player:view'),
            ),
          );
        expect(denials.length).toBeGreaterThan(0);
      },
      { timeout: 15_000, interval: 100 },
    );
  });
});

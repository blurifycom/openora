import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { PLAYER_ACCOUNT_MANAGER_READER } from '@openora/core/contracts';
import { DRIZZLE, eventOutbox } from '@openora/core/server';
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

const AUDIT_ACTION = 'admin.player.account_manager_changed';
const TOPIC = 'player.account_manager.changed';
const CLIENT_IP = '198.51.100.7';
const CLIENT_AGENT = 'account-manager-e2e';

type Account = { client: TestClient; userId: string; playerId: string; name: string };

let db: TestDb;
let testApp: TestApp;
let admin: TestClient;
let adminUserId: string;

const drizzle = () => testApp.container.get(DRIZZLE).db;

async function newPlayer(): Promise<Account> {
  const name = `player ${randomUUID()}`;
  const account = await registerAndMaterializePlayer(testApp, {
    email: `account-manager-${randomUUID()}@e2e.test`,
  });
  await drizzle().update(user).set({ name }).where(eq(user.id, account.userId));
  return { ...account, name };
}

async function newStaff(roleKey: string, name = `staff ${randomUUID()}`): Promise<Account> {
  const account = await newPlayer();
  await assignIamRoleByKey(testApp.container, account.userId, roleKey);
  await drizzle().update(user).set({ name }).where(eq(user.id, account.userId));
  return { ...account, name };
}

const setManager = (client: TestClient, playerId: string, accountManagerId: string | null) =>
  client.put(`/players/${playerId}/account-manager`, { accountManagerId });

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

async function managerOf(playerId: string) {
  const res = await admin.get(`/players/${playerId}`);
  expect(res.status).toBe(200);
  return (await json(res))['accountManager'];
}

const auditRows = (playerId: string) =>
  drizzle()
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, AUDIT_ACTION), eq(auditLog.resourceId, playerId)))
    .orderBy(auditLog.seq);

const outboxRows = (playerId: string) =>
  drizzle()
    .select({ payload: eventOutbox.payload })
    .from(eventOutbox)
    .where(
      and(eq(eventOutbox.topic, TOPIC), sql`${eventOutbox.payload}->>'playerId' = ${playerId}`),
    )
    .orderBy(eventOutbox.createdAt);

const deactivate = (userId: string) =>
  drizzle().update(user).set({ isActive: false }).where(eq(user.id, userId));

beforeAll(async () => {
  ({ db, app: testApp } = await bootE2e());
  admin = await asAdmin(testApp.app);
  const [account] = await drizzle()
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, 'admin@oss.dev'));
  if (!account) {
    throw new Error('no seeded admin account');
  }
  adminUserId = account.id;
}, 60_000);

afterAll(async () => {
  await closeE2e({ app: testApp, db });
});

describe('PUT /players/{playerId}/account-manager', () => {
  it('assigns, changes and removes the manager, auditing and emitting each change', async () => {
    const p = await newPlayer();
    const first = await newStaff('vip-manager');
    const second = await newStaff('support-manager');

    const assigned = await admin.request(`/players/${p.playerId}/account-manager`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-real-ip': CLIENT_IP,
        'user-agent': CLIENT_AGENT,
      },
      body: JSON.stringify({ accountManagerId: first.userId }),
    });
    expect(assigned.status).toBe(200);
    expect(await json(assigned)).toEqual({
      accountManager: {
        userId: first.userId,
        name: first.name,
        email: expect.any(String),
        isActive: true,
      },
    });
    expect(await managerOf(p.playerId)).toMatchObject({ userId: first.userId, isActive: true });

    expect((await setManager(admin, p.playerId, second.userId)).status).toBe(200);
    const removed = await setManager(admin, p.playerId, null);
    expect(removed.status).toBe(200);
    expect(await json(removed)).toEqual({ accountManager: null });
    expect(await managerOf(p.playerId)).toBeNull();

    const audits = await auditRows(p.playerId);
    expect(audits.map(({ before, after }) => ({ before, after }))).toEqual([
      { before: { accountManagerId: null }, after: { accountManagerId: first.userId } },
      { before: { accountManagerId: first.userId }, after: { accountManagerId: second.userId } },
      { before: { accountManagerId: second.userId }, after: { accountManagerId: null } },
    ]);
    expect(audits[0]).toMatchObject({
      actorType: 'admin',
      actorId: adminUserId,
      resourceType: 'player',
      ip: CLIENT_IP,
      userAgent: CLIENT_AGENT,
    });
    expect((await outboxRows(p.playerId)).map(({ payload }) => payload)).toEqual([
      expect.objectContaining({
        playerId: p.playerId,
        userId: p.userId,
        previousAccountManagerId: null,
        accountManagerId: first.userId,
        actorId: adminUserId,
      }),
      expect.objectContaining({
        previousAccountManagerId: first.userId,
        accountManagerId: second.userId,
      }),
      expect.objectContaining({ previousAccountManagerId: second.userId, accountManagerId: null }),
    ]);
  });

  it('writes one audit row and one event when the same manager is set twice', async () => {
    const p = await newPlayer();
    const manager = await newStaff('vip-manager');
    expect((await setManager(admin, p.playerId, manager.userId)).status).toBe(200);
    const again = await setManager(admin, p.playerId, manager.userId);
    expect(again.status).toBe(200);
    expect(await json(again)).toMatchObject({ accountManager: { userId: manager.userId } });
    expect(await auditRows(p.playerId)).toHaveLength(1);
    expect(await outboxRows(p.playerId)).toHaveLength(1);
  });

  it('refuses view-only staff with 403 and leaves the manager unchanged', async () => {
    const p = await newPlayer();
    const manager = await newStaff('vip-manager');
    const viewer = await newStaff('customer-support-agent');
    expect((await setManager(admin, p.playerId, manager.userId)).status).toBe(200);

    expect((await setManager(viewer.client, p.playerId, viewer.userId)).status).toBe(403);
    expect((await setManager(viewer.client, p.playerId, null)).status).toBe(403);
    expect(await managerOf(p.playerId)).toMatchObject({ userId: manager.userId });
    expect(await auditRows(p.playerId)).toHaveLength(1);
  });

  it('refuses a player session on every account-manager route and never shows the manager to the player', async () => {
    const p = await newPlayer();
    const manager = await newStaff('vip-manager');
    expect((await setManager(admin, p.playerId, manager.userId)).status).toBe(200);

    expect((await setManager(p.client, p.playerId, null)).status).toBe(403);
    expect((await p.client.get('/players/account-managers')).status).toBe(403);
    expect((await p.client.get(`/players?accountManagerId=${manager.userId}`)).status).toBe(403);
    expect(await managerOf(p.playerId)).toMatchObject({ userId: manager.userId });

    const profile = await p.client.get('/profile');
    expect(profile.status).toBe(200);
    expect(await json(profile)).not.toHaveProperty('accountManager');
    const card = await p.client.get(`/players/${p.userId}/profile-card`);
    expect(card.status).toBe(200);
    expect(await json(card)).not.toHaveProperty('accountManager');
  });

  it('answers 404 for an unknown player', async () => {
    const manager = await newStaff('vip-manager');
    expect((await setManager(admin, randomUUID(), manager.userId)).status).toBe(404);
  });

  it.each([
    ['an unknown user', 'unknown', async () => randomUUID()],
    [
      'an inactive staff member',
      'inactive',
      async () => {
        const staff = await newStaff('vip-manager');
        await deactivate(staff.userId);
        return staff.userId;
      },
    ],
    ['a player', 'not_eligible', async () => (await newPlayer()).userId],
    [
      'staff without player:view',
      'not_eligible',
      async () => (await newStaff('marketing-banners')).userId,
    ],
  ])('answers 422 for %s with reason %s', async (_label, reason, candidate) => {
    const p = await newPlayer();
    const res = await setManager(admin, p.playerId, await candidate());
    expect(res.status).toBe(422);
    expect(await json(res)).toMatchObject({ data: { reason } });
    expect(await managerOf(p.playerId)).toBeNull();
    expect(await auditRows(p.playerId)).toHaveLength(0);
  });

  it('keeps a deactivated manager as inactive, lets it be replaced but never re-assigned', async () => {
    const p = await newPlayer();
    const manager = await newStaff('vip-manager');
    const replacement = await newStaff('vip-manager');
    expect((await setManager(admin, p.playerId, manager.userId)).status).toBe(200);
    await deactivate(manager.userId);

    expect(await managerOf(p.playerId)).toMatchObject({ userId: manager.userId, isActive: false });
    const reassigned = await setManager(admin, p.playerId, manager.userId);
    expect(reassigned.status).toBe(422);
    expect(await json(reassigned)).toMatchObject({ data: { reason: 'inactive' } });
    expect((await setManager(admin, p.playerId, replacement.userId)).status).toBe(200);
    expect(await managerOf(p.playerId)).toMatchObject({ userId: replacement.userId });
    expect((await setManager(admin, p.playerId, manager.userId)).status).toBe(422);
  });

  it.each([
    [
      'a status change',
      (p: Account) => admin.patch(`/players/${p.playerId}`, { status: 'suspended' }),
    ],
    ['a closure', (p: Account) => admin.del(`/players/${p.playerId}`)],
    [
      'a self-exclusion',
      (p: Account) =>
        admin.post(`/compliance/players/${p.userId}/self-exclusion`, {
          isPermanent: true,
          reason: 'account manager e2e',
          confirm: true,
        }),
    ],
    [
      'a cooling-off',
      (p: Account) =>
        admin.post(`/compliance/players/${p.userId}/cooling-off`, {
          durationHours: 24,
          reason: 'account manager e2e',
        }),
    ],
  ])('keeps the manager through %s', async (_label, change) => {
    const p = await newPlayer();
    const manager = await newStaff('vip-manager');
    expect((await setManager(admin, p.playerId, manager.userId)).status).toBe(200);
    const res = await change(p);
    expect(res.status, await res.clone().text()).toBeLessThan(300);
    expect(await managerOf(p.playerId)).toMatchObject({ userId: manager.userId });
  });
});

describe('GET /players?accountManagerId=', () => {
  it("filters and pages a manager's players, and serves a manager their own", async () => {
    const manager = await newStaff('vip-manager');
    const players = [await newPlayer(), await newPlayer(), await newPlayer()];
    await newPlayer();
    for (const p of players) {
      expect((await setManager(admin, p.playerId, manager.userId)).status).toBe(200);
    }

    const page1 = await json(
      await admin.get(`/players?accountManagerId=${manager.userId}&limit=2&page=1`),
    );
    const page2 = await json(
      await admin.get(`/players?accountManagerId=${manager.userId}&limit=2&page=2`),
    );
    expect(page1['total']).toBe(3);
    const items = [
      ...(page1['items'] as { id: string }[]),
      ...(page2['items'] as { id: string }[]),
    ];
    expect(items.map(({ id }) => id).sort()).toEqual(players.map((p) => p.playerId).sort());
    expect(items).toEqual(
      items.map(() =>
        expect.objectContaining({
          accountManager: {
            userId: manager.userId,
            name: manager.name,
            email: expect.any(String),
            isActive: true,
          },
        }),
      ),
    );

    const mine = await manager.client.get(`/players?accountManagerId=${manager.userId}`);
    expect(mine.status).toBe(200);
    expect((await json(mine))['total']).toBe(3);
  });
});

describe('GET /players/account-managers', () => {
  it('lists only active staff holding player:view whose name or email matches', async () => {
    const token = randomUUID().slice(0, 8);
    const eligible = await newStaff('vip-manager', `${token} eligible`);
    const viewer = await newStaff('customer-support-agent', `${token} viewer`);
    await newStaff('marketing-banners', `${token} marketing`);
    const inactive = await newStaff('vip-manager', `${token} inactive`);
    await deactivate(inactive.userId);
    const p = await newPlayer();
    await drizzle()
      .update(user)
      .set({ name: `${token} player` })
      .where(eq(user.id, p.userId));

    const res = await admin.get(`/players/account-managers?search=${token}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { userId: eligible.userId, name: eligible.name, email: expect.any(String) },
      { userId: viewer.userId, name: viewer.name, email: expect.any(String) },
    ]);
    const limited = await admin.get(`/players/account-managers?search=${token}&limit=1`);
    expect(await limited.json()).toHaveLength(1);
  });

  it('matches % and _ in the search literally', async () => {
    const token = randomUUID().slice(0, 8);
    const literal = await newStaff('vip-manager', `${token} 50%_x`);
    await newStaff('vip-manager', `${token} 50ab x`);
    const res = await admin.get(
      `/players/account-managers?search=${encodeURIComponent(`${token} 50%_`)}`,
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown[]).toEqual([
      expect.objectContaining({ userId: literal.userId }),
    ]);
  });

  it('refuses a search over 100 characters', async () => {
    expect((await admin.get(`/players/account-managers?search=${'a'.repeat(101)}`)).status).toBe(
      400,
    );
  });
});

describe('PLAYER_ACCOUNT_MANAGER_READER', () => {
  it("reads a player's manager by their user id, and null for none or an unknown player", async () => {
    const reader = testApp.container.get(PLAYER_ACCOUNT_MANAGER_READER);
    const p = await newPlayer();
    const manager = await newStaff('vip-manager');
    expect(await reader.getByPlayerUserId(p.userId)).toBeNull();
    expect((await setManager(admin, p.playerId, manager.userId)).status).toBe(200);
    expect(await reader.getByPlayerUserId(p.userId)).toEqual({
      userId: manager.userId,
      name: manager.name,
      email: expect.any(String),
      isActive: true,
    });
    expect(await reader.getByPlayerUserId(randomUUID())).toBeNull();
  });
});

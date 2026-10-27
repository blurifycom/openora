import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '@openora/core/server';
import { adminRole } from '@openora/core/iam/schema';
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

const ROUTE = '/players/account-managers/assigned';

type Account = { client: TestClient; userId: string; playerId: string; name: string };
type Manager = { userId: string; name: string; isActive: boolean };

let db: TestDb;
let testApp: TestApp;
let admin: TestClient;

const drizzle = () => testApp.container.get(DRIZZLE).db;

async function newPlayer(): Promise<Account> {
  const name = `player ${randomUUID()}`;
  const account = await registerAndMaterializePlayer(testApp, {
    email: `account-manager-list-${randomUUID()}@e2e.test`,
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

async function setManager(playerId: string, accountManagerId: string | null) {
  const res = await admin.put(`/players/${playerId}/account-manager`, { accountManagerId });
  expect(res.status, await res.clone().text()).toBe(200);
}

const deactivate = (userId: string) =>
  drizzle().update(user).set({ isActive: false }).where(eq(user.id, userId));

async function assigned(client: TestClient = admin): Promise<Manager[]> {
  const res = await client.get(ROUTE);
  expect(res.status).toBe(200);
  return (await res.json()) as Manager[];
}

const assignedIds = async () => (await assigned()).map(({ userId }) => userId);

async function managedTotal(accountManagerId: string): Promise<number> {
  const res = await admin.get(`/players?accountManagerId=${accountManagerId}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { total: number }).total;
}

async function roleId(key: string): Promise<string> {
  const [role] = await drizzle()
    .select({ id: adminRole.id })
    .from(adminRole)
    .where(eq(adminRole.key, key));
  if (!role) {
    throw new Error(`no seeded admin_role with key='${key}'`);
  }
  return role.id;
}

beforeAll(async () => {
  ({ db, app: testApp } = await bootE2e());
  admin = await asAdmin(testApp.app);
}, 60_000);

afterAll(async () => {
  await closeE2e({ app: testApp, db });
});

describe('GET /players/account-managers/assigned', () => {
  it('lists an assigned manager as exactly userId, name and isActive', async () => {
    const p = await newPlayer();
    const manager = await newStaff('vip-manager');
    await setManager(p.playerId, manager.userId);

    const entries = (await assigned()).filter(({ userId }) => userId === manager.userId);
    expect(entries).toEqual([{ userId: manager.userId, name: manager.name, isActive: true }]);
  });

  it('keeps a deactivated manager who still has players, as inactive', async () => {
    const p = await newPlayer();
    const manager = await newStaff('vip-manager');
    await setManager(p.playerId, manager.userId);
    await deactivate(manager.userId);

    expect((await assigned()).find(({ userId }) => userId === manager.userId)).toEqual({
      userId: manager.userId,
      name: manager.name,
      isActive: false,
    });
  });

  it('leaves out staff with no players, and follows unassignment and reassignment', async () => {
    const idle = await newStaff('vip-manager');
    expect(await assignedIds()).not.toContain(idle.userId);

    const p = await newPlayer();
    const manager = await newStaff('vip-manager');
    await setManager(p.playerId, manager.userId);
    expect(await assignedIds()).toContain(manager.userId);
    await setManager(p.playerId, null);
    expect(await assignedIds()).not.toContain(manager.userId);

    const moved = await newPlayer();
    const from = await newStaff('vip-manager');
    const to = await newStaff('support-manager');
    await setManager(moved.playerId, from.userId);
    await setManager(moved.playerId, to.userId);
    const ids = await assignedIds();
    expect(ids).not.toContain(from.userId);
    expect(ids).toContain(to.userId);
  });

  it('orders by name, then by user id for equal names', async () => {
    const token = randomUUID().slice(0, 8);
    const staff = [
      await newStaff('vip-manager', `${token} b`),
      await newStaff('vip-manager', `${token} a`),
      await newStaff('vip-manager', `${token} c`),
      await newStaff('vip-manager', `${token} c`),
    ];
    for (const s of staff) {
      await setManager((await newPlayer()).playerId, s.userId);
    }
    const [b, a, c1, c2] = staff as [Account, Account, Account, Account];
    const cs = [c1.userId, c2.userId].sort();

    const mine = (await assigned()).filter(({ name }) => name.startsWith(token));
    expect(mine.map(({ userId }) => userId)).toEqual([a.userId, b.userId, ...cs]);
  });

  it('lists a manager of several players once', async () => {
    const manager = await newStaff('vip-manager');
    for (let i = 0; i < 3; i++) {
      await setManager((await newPlayer()).playerId, manager.userId);
    }
    expect((await assignedIds()).filter((id) => id === manager.userId)).toHaveLength(1);
  });

  it('serves player:view staff, refuses staff without it and players with 403, and no session with 401', async () => {
    const viewer = await newStaff('customer-support-agent');
    const outsider = await newStaff('marketing-banners');
    const p = await newPlayer();

    expect(Array.isArray(await assigned(viewer.client))).toBe(true);
    expect((await outsider.client.get(ROUTE)).status).toBe(403);
    expect((await p.client.get(ROUTE)).status).toBe(403);
    expect((await testApp.app.request(ROUTE, { method: 'GET' })).status).toBe(401);
  });

  it('keeps a manager whose role lost player:view, though no longer a candidate', async () => {
    const token = randomUUID().slice(0, 8);
    const p = await newPlayer();
    const manager = await newStaff('vip-manager', `${token} manager`);
    await setManager(p.playerId, manager.userId);

    const moveRole = await admin.request('/iam/assignments', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: manager.userId, roleId: await roleId('vip-manager') }),
    });
    expect(moveRole.status, await moveRole.clone().text()).toBe(200);
    await assignIamRoleByKey(testApp.container, manager.userId, 'marketing-banners');

    await vi.waitFor(async () => {
      const res = await admin.get(`/players/account-managers?search=${token}`);
      expect(await res.json()).toEqual([]);
    });
    expect((await assigned()).find(({ userId }) => userId === manager.userId)).toEqual({
      userId: manager.userId,
      name: manager.name,
      isActive: true,
    });
  });

  it('agrees with the accountManagerId filter on GET /players, closed players included', async () => {
    const open = await newStaff('vip-manager');
    const closedOnly = await newStaff('vip-manager');
    await setManager((await newPlayer()).playerId, open.userId);
    const closing = await newPlayer();
    await setManager(closing.playerId, closedOnly.userId);
    expect((await admin.del(`/players/${closing.playerId}`)).status).toBe(200);

    const ids = await assignedIds();
    for (const manager of [open, closedOnly]) {
      expect(ids).toContain(manager.userId);
      expect(await managedTotal(manager.userId)).toBeGreaterThanOrEqual(1);
    }
  });

  it('leaves the neighbouring player routes reachable', async () => {
    const token = randomUUID().slice(0, 8);
    const p = await newPlayer();
    const manager = await newStaff('vip-manager', `${token} neighbour`);

    const candidates = await admin.get(`/players/account-managers?search=${token}`);
    expect(candidates.status).toBe(200);
    expect(await candidates.json()).toEqual([{ userId: manager.userId, name: manager.name }]);
    await setManager(p.playerId, manager.userId);
    const detail = await admin.get(`/players/${p.playerId}`);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ accountManager: { userId: manager.userId } });
  });
});

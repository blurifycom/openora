import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { and, eq, sql } from 'drizzle-orm';
import { PLAYER_ACCOUNT_MANAGER_READER } from '@openora/core/contracts';
import { ADMIN_GUARD, DRIZZLE, eventOutbox } from '@openora/core/server';
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
  it('lists only active staff holding player:view whose name matches, never by email', async () => {
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
      { userId: eligible.userId, name: eligible.name },
      { userId: viewer.userId, name: viewer.name },
    ]);
    const limited = await admin.get(`/players/account-managers?search=${token}&limit=1`);
    expect(await limited.json()).toHaveLength(1);
    const byEmail = await admin.get(
      `/players/account-managers?search=${encodeURIComponent('@e2e.test')}`,
    );
    expect(await byEmail.json()).toEqual([]);
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
      isActive: true,
    });
    expect(await reader.getByPlayerUserId(randomUUID())).toBeNull();
  });
});

describe('account-manager permissions and input', () => {
  it('names player:update in the 403, records the denial, and still lets the same session read', async () => {
    const p = await newPlayer();
    const manager = await newStaff('vip-manager');
    const viewer = await newStaff('customer-support-agent');
    expect((await setManager(admin, p.playerId, manager.userId)).status).toBe(200);

    const denied = await setManager(viewer.client, p.playerId, null);
    expect(denied.status).toBe(403);
    expect(await json(denied)).toMatchObject({
      data: { reason: 'permission_denied', resource: 'player', action: 'update' },
    });
    await vi.waitFor(
      async () => {
        const rows = await drizzle()
          .select({ actorId: auditLog.actorId, result: auditLog.result })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.action, 'identity.user.unauthorized_access'),
              eq(auditLog.resourceId, 'player:update'),
            ),
          );
        expect(rows).toContainEqual(
          expect.objectContaining({ actorId: viewer.userId, result: 'failure' }),
        );
      },
      { timeout: 15_000, interval: 100 },
    );

    const read = await viewer.client.get(`/players/${p.playerId}`);
    expect(read.status).toBe(200);
    expect(await json(read)).toMatchObject({ accountManager: { userId: manager.userId } });
    expect((await viewer.client.get('/players/account-managers')).status).toBe(200);
  });

  it('refuses staff without player:view on every account-manager route, even for their own id', async () => {
    const p = await newPlayer();
    const outsider = await newStaff('marketing-banners');
    expect((await setManager(outsider.client, p.playerId, outsider.userId)).status).toBe(403);
    expect((await outsider.client.get('/players/account-managers')).status).toBe(403);
    expect(await managerOf(p.playerId)).toBeNull();
    expect(await auditRows(p.playerId)).toHaveLength(0);
  });

  it('answers 401 with no session', async () => {
    const p = await newPlayer();
    const anonymous = (path: string, init: RequestInit) => testApp.app.request(path, init);
    const put = await anonymous(`/players/${p.playerId}/account-manager`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountManagerId: null }),
    });
    expect(put.status).toBe(401);
    expect((await anonymous('/players/account-managers', { method: 'GET' })).status).toBe(401);
    expect(
      (await anonymous(`/players?accountManagerId=${randomUUID()}`, { method: 'GET' })).status,
    ).toBe(401);
  });

  it('lets an admin assign themselves when they hold player:view', async () => {
    const p = await newPlayer();
    const res = await setManager(admin, p.playerId, adminUserId);
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ accountManager: { userId: adminUserId } });
  });

  it.each([
    [
      'a non-uuid player id',
      () => `/players/not-a-uuid/account-manager`,
      { accountManagerId: null },
    ],
    [
      'a non-uuid manager id',
      (p: Account) => `/players/${p.playerId}/account-manager`,
      { accountManagerId: 'nope' },
    ],
    ['a missing manager id', (p: Account) => `/players/${p.playerId}/account-manager`, {}],
    [
      'an empty-string manager id',
      (p: Account) => `/players/${p.playerId}/account-manager`,
      { accountManagerId: '' },
    ],
  ])('answers 400 for %s and changes nothing', async (_label, path, body) => {
    const p = await newPlayer();
    const manager = await newStaff('vip-manager');
    expect((await setManager(admin, p.playerId, manager.userId)).status).toBe(200);
    expect((await admin.put(path(p), body)).status).toBe(400);
    expect(await managerOf(p.playerId)).toMatchObject({ userId: manager.userId });
    expect(await auditRows(p.playerId)).toHaveLength(1);
  });

  it.each(['0', '-1', '51', 'abc', '1.5'])('answers 400 for candidate limit %s', async (limit) => {
    expect((await admin.get(`/players/account-managers?limit=${limit}`)).status).toBe(400);
  });

  it('answers 400 for a non-uuid accountManagerId filter and an empty list for an unknown one', async () => {
    expect((await admin.get('/players?accountManagerId=nope')).status).toBe(400);
    const none = await admin.get(`/players?accountManagerId=${randomUUID()}`);
    expect(none.status).toBe(200);
    expect(await json(none)).toMatchObject({ total: 0, items: [] });
  });
});

describe('account-manager concurrency', () => {
  it('serializes two parallel assignments: one final manager, each audit row chained to the last', async () => {
    const p = await newPlayer();
    const a = await newStaff('vip-manager');
    const b = await newStaff('support-manager');

    const [resA, resB] = await Promise.all([
      setManager(admin, p.playerId, a.userId),
      setManager(admin, p.playerId, b.userId),
    ]);
    expect([resA.status, resB.status]).toEqual([200, 200]);

    const audits = await auditRows(p.playerId);
    expect(audits).toHaveLength(2);
    expect(audits[0]?.before).toEqual({ accountManagerId: null });
    expect(audits[1]?.before).toEqual(audits[0]?.after);
    const current = await managerOf(p.playerId);
    expect([a.userId, b.userId]).toContain((current as { userId: string }).userId);
    expect(audits[1]?.after).toEqual({
      accountManagerId: (current as { userId: string }).userId,
    });
    expect(await outboxRows(p.playerId)).toHaveLength(2);
  });

  it('writes one audit row when the same assignment is sent twice in parallel', async () => {
    const p = await newPlayer();
    const a = await newStaff('vip-manager');
    const results = await Promise.all([
      setManager(admin, p.playerId, a.userId),
      setManager(admin, p.playerId, a.userId),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(await auditRows(p.playerId)).toHaveLength(1);
    expect(await outboxRows(p.playerId)).toHaveLength(1);
  });
});

describe('account-manager reads beside the player record', () => {
  it('returns accountManager null for an unmanaged player and the manager from PATCH', async () => {
    const p = await newPlayer();
    const manager = await newStaff('vip-manager');
    const listed = await admin.get('/players?limit=100&sortOrder=desc');
    expect(listed.status).toBe(200);
    const items = (await json(listed))['items'] as { id: string; accountManager: unknown }[];
    expect(items.find(({ id }) => id === p.playerId)).toMatchObject({ accountManager: null });
    expect(await managerOf(p.playerId)).toBeNull();

    expect((await setManager(admin, p.playerId, manager.userId)).status).toBe(200);
    const patched = await admin.patch(`/players/${p.playerId}`, { status: 'suspended' });
    expect(patched.status).toBe(200);
    expect(await json(patched)).toMatchObject({
      status: 'suspended',
      accountManager: { userId: manager.userId, isActive: true },
    });
  });

  it('leaves the unfiltered total unchanged by assigning managers', async () => {
    const p = await newPlayer();
    const manager = await newStaff('vip-manager');
    const before = (await json(await admin.get('/players?limit=1')))['total'];
    expect((await setManager(admin, p.playerId, manager.userId)).status).toBe(200);
    expect((await json(await admin.get('/players?limit=1')))['total']).toBe(before);
  });
});

describe('GET /players/account-managers batch scan', () => {
  it('still finds an eligible manager behind more than two batches of ineligible staff', async () => {
    const token = randomUUID().slice(0, 8);
    const ineligible = Array.from({ length: 230 }, (_, i) => ({
      name: `${token} a${String(i).padStart(3, '0')}`,
      username: `u${token}${i}`,
      email: `${token}-${i}@scan.e2e.test`,
      role: 'admin',
    }));
    await drizzle().insert(user).values(ineligible);
    const eligible = await newStaff('vip-manager', `${token} z eligible`);

    const res = await admin.get(`/players/account-managers?search=${token}&limit=5`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ userId: eligible.userId, name: eligible.name }]);
  });
});

describe('account-manager deactivation race', () => {
  it('refuses a manager deactivated while the assignment waits on the player row lock', async () => {
    const p = await newPlayer();
    const manager = await newStaff('vip-manager');
    const holder = new Client({ connectionString: db.url });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM player WHERE id = $1 FOR UPDATE', [p.playerId]);
      const {
        rows: [{ pid: holderPid } = { pid: 0 }],
      } = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');

      const pending = setManager(admin, p.playerId, manager.userId);
      await vi.waitFor(
        async () => {
          const { rows } = await holder.query<{ waiting: number }>(
            'SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
            [holderPid],
          );
          expect(rows[0]?.waiting).toBe(1);
        },
        { timeout: 15_000, interval: 25 },
      );
      await deactivate(manager.userId);
      await holder.query('COMMIT');

      const res = await pending;
      expect(res.status).toBe(422);
      expect(await json(res)).toMatchObject({ data: { reason: 'inactive' } });
    } finally {
      await holder.end();
    }
    expect(await managerOf(p.playerId)).toBeNull();
    expect(await auditRows(p.playerId)).toHaveLength(0);
  });

  it.each([
    ['commits', 'COMMIT', 422, null],
    ['rolls back', 'ROLLBACK', 200, 'manager'],
  ])(
    'waits behind a deactivation that holds the user row lock first, then %s',
    async (_label, finish, status, stored) => {
      const p = await newPlayer();
      const manager = await newStaff('vip-manager');
      const holder = new Client({ connectionString: db.url });
      await holder.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('UPDATE "user" SET is_active = false WHERE id = $1', [manager.userId]);
        const {
          rows: [{ pid: holderPid } = { pid: 0 }],
        } = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');

        const pending = setManager(admin, p.playerId, manager.userId);
        await vi.waitFor(
          async () => {
            const { rows } = await holder.query<{ waiting: number }>(
              'SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
              [holderPid],
            );
            expect(rows[0]?.waiting).toBe(1);
          },
          { timeout: 15_000, interval: 25 },
        );
        await holder.query(finish);

        const res = await pending;
        expect(res.status).toBe(status);
        if (status === 422) {
          expect(await json(res)).toMatchObject({ data: { reason: 'inactive' } });
        }
      } finally {
        await holder.end();
      }
      expect(await auditRows(p.playerId)).toHaveLength(stored ? 1 : 0);
      if (stored) {
        expect(await managerOf(p.playerId)).toMatchObject({ userId: manager.userId });
      } else {
        expect(await managerOf(p.playerId)).toBeNull();
      }
    },
  );

  it('answers 422 inactive when the current manager is deactivated and set again, and still lets it be removed', async () => {
    const p = await newPlayer();
    const manager = await newStaff('vip-manager');
    expect((await setManager(admin, p.playerId, manager.userId)).status).toBe(200);
    await deactivate(manager.userId);

    const again = await setManager(admin, p.playerId, manager.userId);
    expect(again.status).toBe(422);
    expect(await json(again)).toMatchObject({ data: { reason: 'inactive' } });
    expect(await managerOf(p.playerId)).toMatchObject({ userId: manager.userId, isActive: false });
    expect(await auditRows(p.playerId)).toHaveLength(1);

    expect((await setManager(admin, p.playerId, null)).status).toBe(200);
    expect(await managerOf(p.playerId)).toBeNull();
  });
});

describe('account manager precedence and exposure', () => {
  it.each([
    ['an unknown user', async () => randomUUID()],
    ['a player', async () => (await newPlayer()).userId],
    ['staff without player:view', async () => (await newStaff('marketing-banners')).userId],
  ])('answers 404 for an unknown player before judging %s', async (_label, candidate) => {
    const res = await setManager(admin, randomUUID(), await candidate());
    expect(res.status).toBe(404);
  });

  it('never carries the manager email in any response that shows the manager', async () => {
    const p = await newPlayer();
    const manager = await newStaff('vip-manager');
    const [{ email } = { email: '' }] = await drizzle()
      .select({ email: user.email })
      .from(user)
      .where(eq(user.id, manager.userId));
    expect(email).toContain('@');

    const responses = [
      await setManager(admin, p.playerId, manager.userId),
      await admin.get(`/players/${p.playerId}`),
      await admin.get(`/players?accountManagerId=${manager.userId}`),
      await admin.patch(`/players/${p.playerId}`, { status: 'suspended' }),
      await admin.get(`/players/account-managers?search=${encodeURIComponent(manager.name)}`),
    ];
    for (const res of responses) {
      expect(res.status).toBe(200);
      const raw = await res.text();
      expect(raw).not.toContain(email);
    }
    expect(
      await testApp.container.get(PLAYER_ACCOUNT_MANAGER_READER).getByPlayerUserId(p.userId),
    ).not.toHaveProperty('email');
  });

  it('leaves out a user whose role is not a static admin role, however its grants look', async () => {
    const token = randomUUID().slice(0, 8);
    const custom = await newStaff('vip-manager', `${token} custom`);
    await drizzle().update(user).set({ role: 'custom-ops' }).where(eq(user.id, custom.userId));
    const staff = await newStaff('vip-manager', `${token} staff`);

    const listed = await admin.get(`/players/account-managers?search=${token}`);
    expect(await listed.json()).toEqual([{ userId: staff.userId, name: staff.name }]);

    const p = await newPlayer();
    const res = await setManager(admin, p.playerId, custom.userId);
    expect(res.status).toBe(422);
    expect(await json(res)).toMatchObject({ data: { reason: 'not_eligible' } });
  });
});

describe('AdminGuard.filterGrantedUsers beside filterGranted', () => {
  it('answers a mixed batch exactly as filterGranted answers each user', async () => {
    const guard = testApp.container.get(ADMIN_GUARD);
    const requirements = [{ resource: 'player', action: 'view' }] as const;
    const withView = await newStaff('vip-manager');
    const viewOnly = await newStaff('customer-support-agent');
    const withoutView = await newStaff('marketing-banners');
    const inactive = await newStaff('vip-manager');
    await deactivate(inactive.userId);
    const staticSupport = await newPlayer();
    await drizzle().update(user).set({ role: 'support' }).where(eq(user.id, staticSupport.userId));
    const custom = await newStaff('vip-manager');
    await drizzle().update(user).set({ role: 'custom-ops' }).where(eq(user.id, custom.userId));
    const playerAccount = await newPlayer();
    const unknown = randomUUID();

    const ids = [
      withView.userId,
      viewOnly.userId,
      withoutView.userId,
      inactive.userId,
      staticSupport.userId,
      custom.userId,
      playerAccount.userId,
      unknown,
      withView.userId,
      unknown,
    ];
    const batch = await guard.filterGrantedUsers(ids, requirements);

    for (const id of new Set(ids)) {
      expect(batch.get(id) ?? [], id).toEqual(await guard.filterGranted(id, requirements));
    }
    expect([...batch.keys()].sort()).toEqual([withView.userId, viewOnly.userId].sort());
    expect(await guard.filterGrantedUsers([], requirements)).toEqual(new Map());
  });

  it('answers no grants for empty requirements, an inactive admin and an unknown id, and rejects a non-uuid id', async () => {
    const guard = testApp.container.get(ADMIN_GUARD);
    const requirements = [{ resource: 'player', action: 'view' }] as const;
    const holder = await newStaff('vip-manager');
    const inactive = await newStaff('vip-manager');
    await deactivate(inactive.userId);

    expect(await guard.filterGranted(holder.userId, requirements)).toEqual([...requirements]);
    expect(await guard.filterGranted(holder.userId, [])).toEqual([]);
    expect(await guard.filterGranted(inactive.userId, requirements)).toEqual([]);
    expect(await guard.filterGranted(randomUUID(), requirements)).toEqual([]);
    await expect(guard.filterGranted('not-a-uuid', requirements)).rejects.toThrow();
  });
});

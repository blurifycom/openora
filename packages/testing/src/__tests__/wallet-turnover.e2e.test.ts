import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE, eventOutbox, loadExtensions, moneyCompare } from '@openora/core/server';
import { WALLET_COMMANDS } from '@openora/core/contracts';
import { auditLog } from '@openora/core/audit/schema';
import { user } from '@openora/core/pam/schema/identity';
import { adminRole, adminRoleAssignment, adminRolePermission } from '@openora/core/iam/schema';
import {
  bootE2e,
  closeE2e,
  flushAudit,
  readJson,
  registerAndMaterializePlayer,
  type TestApp,
  type TestClient,
  type TestDb,
} from '../index.js';
import { scheduledIds, waitForSchedule } from './support/job-schedules.js';

const fixture = (name: string) => fileURLToPath(new URL(name, import.meta.url));

let db: TestDb;
let app: TestApp;
let admin: TestClient;
let adminUserId: string;

const drizzle = () => app.container.get(DRIZZLE).db;

const expectMoney = (actual: unknown, expected: string, label: string) =>
  expect(moneyCompare(String(actual), expected) === 0, `${label}: ${String(actual)}`).toBe(true);

async function player() {
  return registerAndMaterializePlayer(app, { email: `turnover-${randomUUID()}@e2e.test` });
}

async function owe(userId: string, amount: string, sourceRef: string = randomUUID()) {
  return drizzle().transaction(async (tx) => {
    const commands = app.container.get(WALLET_COMMANDS);
    if (!commands.addTurnoverRequirement) {
      throw new Error('addTurnoverRequirement is not bound');
    }
    return commands.addTurnoverRequirement(tx, {
      userId,
      currency: 'USD',
      requiredInCurrency: amount,
      source: 'grant_conversion',
      sourceRef,
    });
  });
}

async function staffWith(grants: Array<[string, 'read' | 'read_write']>) {
  const staff = await player();
  await drizzle().update(user).set({ role: 'admin' }).where(eq(user.id, staff.userId));
  const [role] = await drizzle()
    .insert(adminRole)
    .values({ name: `turnover staff ${randomUUID()}` })
    .returning({ id: adminRole.id });
  if (!role) {
    throw new Error('role insert returned no row');
  }
  for (const [resource, level] of grants) {
    await drizzle().insert(adminRolePermission).values({ roleId: role.id, resource, level });
  }
  await drizzle().insert(adminRoleAssignment).values({ userId: staff.userId, roleId: role.id });
  return staff.client;
}

const auditRows = async (action: string, resourceId?: string) => {
  await flushAudit(app);
  return drizzle()
    .select()
    .from(auditLog)
    .where(
      resourceId === undefined
        ? eq(auditLog.action, action)
        : and(eq(auditLog.action, action), eq(auditLog.resourceId, resourceId)),
    )
    .orderBy(auditLog.seq);
};

const clearedEvents = (userId: string) =>
  drizzle()
    .select({ payload: eventOutbox.payload })
    .from(eventOutbox)
    .where(
      and(
        eq(eventOutbox.topic, 'wallet.turnover.cleared'),
        sql`${eventOutbox.payload}->>'userId' = ${userId}`,
      ),
    );

beforeAll(async () => {
  ({ db, app } = await bootE2e({
    plugins: [
      ...(await loadExtensions()),
      {
        id: 'testing-wallet-turnover-config',
        path: fixture('./support/test-wallet-turnover-config-plugin.ts'),
      },
    ],
  }));
  const registered = await player();
  await drizzle().update(user).set({ role: 'admin' }).where(eq(user.id, registered.userId));
  const [role] = await drizzle().select().from(adminRole).where(eq(adminRole.key, 'super-admin'));
  if (!role) {
    throw new Error('no seeded super-admin role');
  }
  await drizzle()
    .insert(adminRoleAssignment)
    .values({ userId: registered.userId, roleId: role.id })
    .onConflictDoNothing();
  admin = registered.client;
  adminUserId = registered.userId;
}, 60_000);

afterAll(async () => {
  await closeE2e({ app, db });
});

describe('turnover pricing schedule', () => {
  it('schedules the pricing job once the multiplier is on', async () => {
    await waitForSchedule(app.redisUrl, 'wallet-turnover-pricing', 'wallet-turnover-pricing.cron');
    expect(await scheduledIds(app.redisUrl, 'wallet-turnover-pricing')).toEqual([
      'wallet-turnover-pricing.cron',
    ]);
  });
});

describe('player turnover reads', () => {
  it('reads an untouched player as enabled with nothing owed', async () => {
    const { client } = await player();

    const res = await client.get('/wallet/turnover');

    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body).toMatchObject({ enabled: true, pivotCurrency: 'USD', locked: false });
    expectMoney(body.required, '0', 'required');
    expectMoney(body.remaining, '0', 'remaining');
  });

  it('shows an added requirement and pages the entries newest first', async () => {
    const { client, userId } = await player();
    const first = await owe(userId, '10');
    const second = await owe(userId, '20');
    const third = await owe(userId, '30');

    const summary = await readJson(await client.get('/wallet/turnover'));
    expect(summary.locked).toBe(true);
    expectMoney(summary.required, '60', 'required');
    expectMoney(summary.remaining, '60', 'remaining');

    const page1 = await client.get('/wallet/turnover/entries?limit=2');
    expect(page1.status).toBe(200);
    const one = await readJson(page1);
    expect(one.items.map((e: { id: string }) => e.id)).toEqual([third.entryId, second.entryId]);
    expect(one.items[0]).toMatchObject({ source: 'grant_conversion', status: 'counted' });
    expect(one.items[0]).not.toHaveProperty('clearedBy');
    expect(one.nextCursor).toBe(second.entryId);

    const two = await readJson(
      await client.get(`/wallet/turnover/entries?limit=2&cursor=${one.nextCursor}`),
    );
    expect(two.items.map((e: { id: string }) => e.id)).toEqual([first.entryId]);
    expect(two.nextCursor).toBeNull();
  });

  it('replays an add with the same source reference', async () => {
    const { userId } = await player();
    const sourceRef = randomUUID();
    const add = () => owe(userId, '5', sourceRef);
    const created = await add();
    const replay = await add();

    expect(replay).toEqual({ entryId: created.entryId, status: 'counted', replayed: true });
    const summary = await readJson(await admin.get(`/wallet/admin/players/${userId}/turnover`));
    expectMoney(summary.required, '5', 'required');
  });

  it('refuses an anonymous read', async () => {
    expect((await app.app.request('/wallet/turnover')).status).toBe(401);
    expect((await app.app.request('/wallet/turnover/entries')).status).toBe(401);
  });

  it('refuses an out-of-range page size', async () => {
    const { client } = await player();

    expect((await client.get('/wallet/turnover/entries?limit=101')).status).toBe(400);
  });
});

describe('staff clear', () => {
  it('clears what is owed, audits it and emits the event once', async () => {
    const { client, userId } = await player();
    const entry = await owe(userId, '25');
    const reason = 'Manual review approved the withdrawal';

    const res = await admin.post(`/wallet/admin/players/${userId}/turnover/clear`, {
      userId,
      reason,
    });

    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.cleared).toBe(true);
    expect(body.summary.locked).toBe(false);
    expectMoney(body.summary.remaining, '0', 'remaining');
    expect((await readJson(await client.get('/wallet/turnover'))).locked).toBe(false);

    const entries = await readJson(
      await admin.get(`/wallet/admin/players/${userId}/turnover/entries`),
    );
    expect(entries.items).toEqual([
      expect.objectContaining({
        id: entry.entryId,
        status: 'cleared',
        clearedBy: adminUserId,
        clearReason: reason,
      }),
    ]);

    const audits = await auditRows('wallet.turnover.cleared', userId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorId: adminUserId, actorType: 'admin' });
    expect(audits[0]?.before).toMatchObject({ pendingCount: 0 });
    expectMoney((audits[0]?.before as { required: string }).required, '25', 'before.required');
    expect(audits[0]?.after).toMatchObject({ reason, entryIds: [entry.entryId] });

    const events = await clearedEvents(userId);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ userId, clearedBy: adminUserId });

    const again = await admin.post(`/wallet/admin/players/${userId}/turnover/clear`, {
      userId,
      reason,
    });
    expect(again.status).toBe(200);
    expect((await readJson(again)).cleared).toBe(false);
    expect(await auditRows('wallet.turnover.cleared', userId)).toHaveLength(1);
    expect(await clearedEvents(userId)).toHaveLength(1);
  });

  it('refuses a blank reason without clearing', async () => {
    const { userId } = await player();
    await owe(userId, '25');

    const res = await admin.post(`/wallet/admin/players/${userId}/turnover/clear`, {
      userId,
      reason: '   ',
    });

    expect(res.status).toBe(400);
    const summary = await readJson(await admin.get(`/wallet/admin/players/${userId}/turnover`));
    expectMoney(summary.remaining, '25', 'remaining');
  });
});

describe('turnover authorization', () => {
  it('refuses a player on the staff routes, even for their own turnover', async () => {
    const { client, userId } = await player();

    expect((await client.get(`/wallet/admin/players/${userId}/turnover`)).status).toBe(403);
    expect((await client.get(`/wallet/admin/players/${userId}/turnover/entries`)).status).toBe(403);
    const clear = await client.post(`/wallet/admin/players/${userId}/turnover/clear`, {
      userId,
      reason: 'clear my own turnover',
    });
    expect(clear.status).toBe(403);
    expect((await client.get('/wallet/admin/turnover-config')).status).toBe(403);
  });

  it('refuses staff without turnover access', async () => {
    const { userId } = await player();
    const staff = await staffWith([['transaction', 'read']]);

    expect((await staff.get(`/wallet/admin/players/${userId}/turnover`)).status).toBe(403);
  });

  it('lets a reader read but not clear', async () => {
    const { userId } = await player();
    await owe(userId, '10');
    const staff = await staffWith([['turnover', 'read']]);

    expect((await staff.get(`/wallet/admin/players/${userId}/turnover`)).status).toBe(200);
    const clear = await staff.post(`/wallet/admin/players/${userId}/turnover/clear`, {
      userId,
      reason: 'reader tries to clear',
    });
    expect(clear.status).toBe(403);
    const summary = await readJson(await admin.get(`/wallet/admin/players/${userId}/turnover`));
    expectMoney(summary.remaining, '10', 'remaining');
  });

  it('lets a config reader read the config but not change it', async () => {
    const staff = await staffWith([['turnover-config', 'read']]);

    expect((await staff.get('/wallet/admin/turnover-config')).status).toBe(200);
    expect(
      (await staff.put('/wallet/admin/turnover-config', { productPercent: { casino: 50 } })).status,
    ).toBe(403);
  });
});

describe('turnover config', () => {
  it('overrides a product weight, resets it with null and audits both', async () => {
    const initial = await readJson(await admin.get('/wallet/admin/turnover-config'));
    expect(initial).toMatchObject({
      creditTypes: ['deposit'],
      countAtSettle: ['sportsbook'],
      pivotCurrency: 'USD',
      productPercent: { casino: 100, 'live-casino': 100, sportsbook: 100, pvp: 0 },
      overrides: {},
    });
    expectMoney(initial.multiplier, '1', 'multiplier');

    const set = await admin.put('/wallet/admin/turnover-config', {
      productPercent: { pvp: 25, casino: 80 },
    });
    expect(set.status).toBe(200);
    expect(await readJson(set)).toMatchObject({
      productPercent: { casino: 80, pvp: 25, sportsbook: 100 },
      overrides: { casino: 80, pvp: 25 },
    });

    const reset = await admin.put('/wallet/admin/turnover-config', {
      productPercent: { casino: null },
    });
    expect(reset.status).toBe(200);
    expect(await readJson(reset)).toMatchObject({
      productPercent: { casino: 100, pvp: 25 },
      overrides: { pvp: 25 },
    });

    const audits = await auditRows('wallet.turnover_config.updated');
    expect(audits.length).toBeGreaterThanOrEqual(2);
    expect(audits.at(-1)).toMatchObject({ actorId: adminUserId, actorType: 'admin' });
    expect(audits.at(-1)?.before).toMatchObject({ productPercent: { casino: 80, pvp: 25 } });
    expect(audits.at(-1)?.after).toEqual({ productPercent: { pvp: 25 } });
  });

  it('refuses a weight out of range or for an unknown product', async () => {
    expect(
      (await admin.put('/wallet/admin/turnover-config', { productPercent: { casino: 101 } }))
        .status,
    ).toBe(400);
    expect(
      (await admin.put('/wallet/admin/turnover-config', { productPercent: { lottery: 10 } }))
        .status,
    ).toBe(400);
  });
});

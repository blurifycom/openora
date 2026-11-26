import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, asc, eq, sql } from 'drizzle-orm';
import * as z from 'zod';
import { auditOutbox, DRIZZLE } from '@openora/core/server';
import { auditLog } from '@openora/core/audit/schema';
import { AuditLogEntrySchema, MyRgHistoryEntrySchema } from '@openora/core/audit/contract';
import { flushAudit, newPlayer, newStaff } from '../index.js';
import {
  bootWalletE2e,
  closeWalletE2e,
  newFundedPlayer,
  postWithdrawal,
  waitForAudit,
  type WalletE2e,
} from './support/wallet.js';
import { newRgPlayer, putLimit, readBody } from './support/compliance.js';
import { newKycPlayer, submitKycOrThrow } from './support/kyc.js';

let e2e: WalletE2e;

const pluginAt = (id: string, file: string) => ({
  id,
  path: fileURLToPath(new URL(file, import.meta.url)),
});

beforeAll(async () => {
  e2e = await bootWalletE2e([
    pluginAt('testing-kyc', './support/test-kyc-plugin.ts'),
    pluginAt('testing-admin-mutation', './support/test-admin-mutation-plugin.ts'),
  ]);
  const config = await e2e.admin.get('/wallet/auto-withdrawal-config');
  if (config.status !== 200) {
    const created = await e2e.admin.put('/wallet/auto-withdrawal-config', {
      fiatThreshold: '0',
      cryptoThreshold: '0',
      excludeRiskFlags: [],
      velocityCount: null,
      velocityWindowHours: 24,
    });
    if (created.status !== 200) {
      throw new Error(`auto-withdrawal config failed (${created.status})`);
    }
  }
}, 60_000);

afterAll(() => closeWalletE2e(e2e));

const db = () => e2e.app.container.get(DRIZZLE).db;

const LogPageSchema = z.object({ items: z.array(AuditLogEntrySchema), total: z.number() });
const HistoryPageSchema = z.object({ items: z.array(MyRgHistoryEntrySchema), total: z.number() });

async function rowsBy(actorId: string, action?: string) {
  await flushAudit(e2e.app);
  return db()
    .select()
    .from(auditLog)
    .where(
      action === undefined
        ? eq(auditLog.actorId, actorId)
        : and(eq(auditLog.actorId, actorId), eq(auditLog.action, action)),
    )
    .orderBy(asc(auditLog.seq));
}

const newSuperAdmin = () => newStaff(e2e.app, 'audit-trail', 'super-admin');

const mutationBody = (overrides: Record<string, unknown> = {}) => ({
  targetId: randomUUID(),
  note: `note ${randomUUID()}`,
  ...overrides,
});

describe('Regulated actions are audited', () => {
  it('a withdrawal request writes exactly one audit row with actor, action and resource', async () => {
    const player = await newFundedPlayer(e2e, '100');

    const { status, body } = await postWithdrawal(player.client, player, { amount: '10' });

    expect(status).toBe(200);
    const transactionId = z.object({ transactionId: z.string() }).parse(body).transactionId;
    const rows = await waitForAudit(e2e, 'wallet.withdrawal.requested', transactionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorType: 'player',
      actorId: player.playerId,
      action: 'wallet.withdrawal.requested',
      resourceType: 'withdrawal',
      resourceId: transactionId,
      after: expect.objectContaining({ currency: player.currency }),
    });
  });

  it('a limit change writes one audit row with the before and after values', async () => {
    const player = await newRgPlayer(e2e);
    await putLimit(player.client, player.currency, { amount: '100' });
    await rowsBy(player.userId);

    await putLimit(player.client, player.currency, { amount: '50' });

    const rows = (await rowsBy(player.userId, 'rg.limit.set')).filter(
      (row) =>
        z.object({ amount: z.string() }).safeParse(row.after).data?.amount ===
        '50.000000000000000000',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorType: 'player',
      resourceType: 'player',
      resourceId: player.playerId,
      before: expect.objectContaining({ amount: '100.000000000000000000' }),
      after: expect.objectContaining({ amount: '50.000000000000000000', type: 'deposit' }),
    });
  });

  it('a self-exclusion writes one audit row for the player actor', async () => {
    const player = await newRgPlayer(e2e);

    const res = await player.client.post('/compliance/rg/self-exclusion', {
      isPermanent: false,
      durationMonths: 6,
      confirm: true,
    });

    expect(res.status).toBe(200);
    const rows = await waitForAudit(e2e, 'rg.self_exclusion.activated', player.playerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorType: 'player',
      actorId: player.userId,
      resourceType: 'player',
    });
  });

  it('a KYC override writes one audit row for the admin actor', async () => {
    const player = await newKycPlayer(e2e);
    await submitKycOrThrow(player.client);
    const officer = await newStaff(e2e.app, 'audit-trail-officer', 'compliance-manager');

    const res = await officer.client.post(`/compliance/players/${player.userId}/kyc/override`, {
      userId: player.userId,
      tier: 'basic',
      status: 'approved',
      reason: 'verified by hand',
    });

    expect(res.status).toBe(200);
    const audited = await waitForAudit(e2e, 'compliance.kyc.updated', player.playerId);
    const byAdmin = audited.filter((row) => row.actorId === officer.userId);
    expect(byAdmin).toHaveLength(1);
    expect(byAdmin[0]).toMatchObject({
      actorType: 'admin',
      after: expect.objectContaining({ kycStatus: 'manually_overridden' }),
    });
  });

  it('a refused regulated action writes no success row', async () => {
    const player = await newFundedPlayer(e2e, '20');

    const { status } = await postWithdrawal(player.client, player, { amount: '1000' });

    expect(status).toBeGreaterThanOrEqual(400);
    const rows = await rowsBy(player.playerId);
    expect(rows.filter((row) => row.action.startsWith('wallet.withdrawal.'))).toHaveLength(0);
  });

  it('repeating the same request does not duplicate the audit row', async () => {
    const player = await newFundedPlayer(e2e, '100');
    const idempotencyKey = randomUUID();

    const first = await postWithdrawal(player.client, player, { amount: '10', idempotencyKey });
    const second = await postWithdrawal(player.client, player, { amount: '10', idempotencyKey });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    const transactionId = z.object({ transactionId: z.string() }).parse(first.body).transactionId;
    const rows = await waitForAudit(e2e, 'wallet.withdrawal.requested', transactionId);
    expect(rows).toHaveLength(1);
  });
});

describe('Admin mutations', () => {
  it('an admin mutation writes an audit row with an input summary', async () => {
    const admin = await newSuperAdmin();
    const body = mutationBody();

    const res = await admin.client.post('/testing/admin-mutation/silent', body);

    expect(res.status).toBe(200);
    const rows = await rowsBy(admin.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'admin.content.update',
      result: 'success',
      resourceId: body.targetId,
      after: {
        route: expect.stringContaining('silent'),
        inputKeys: ['note', 'targetId'],
        inputHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
  });

  it('the input summary omits secrets and credentials', async () => {
    const admin = await newSuperAdmin();
    const password = `pw-${randomUUID()}`;
    const note = `note-${randomUUID()}`;

    const res = await admin.client.post(
      '/testing/admin-mutation/silent',
      mutationBody({ password, note }),
    );

    expect(res.status).toBe(200);
    const rows = await rowsBy(admin.userId);
    expect(rows).toHaveLength(1);
    const stored = JSON.stringify(rows[0]);
    expect(stored).not.toContain(password);
    expect(stored).not.toContain(note);
    expect(rows[0]?.after).toMatchObject({ inputKeys: ['note', 'password', 'targetId'] });
  });

  it('an admin read does not write a mutation row', async () => {
    const admin = await newSuperAdmin();

    const res = await admin.client.get('/testing/admin-mutation/read');

    expect(res.status).toBe(200);
    expect(await rowsBy(admin.userId)).toHaveLength(0);
  });

  it('a failed admin mutation records the failure result', async () => {
    const admin = await newSuperAdmin();

    const res = await admin.client.post('/testing/admin-mutation/failing', mutationBody());

    expect(res.status).toBe(409);
    const rows = await rowsBy(admin.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'admin.content.update',
      result: 'failure',
      after: expect.objectContaining({ errorCode: 'CONFLICT' }),
    });
  });
});

const trailEntry = (overrides: Record<string, unknown>) => ({
  actorType: 'system',
  resourceType: 'trail',
  resourceId: null,
  correlationId: null,
  ...overrides,
});

async function queueTrailRows(
  rows: { actorId: string; action: string; createdAt: string }[],
): Promise<void> {
  await db()
    .insert(auditOutbox)
    .values(rows.map((row) => ({ eventId: randomUUID(), entry: trailEntry(row) })));
  await flushAudit(e2e.app);
}

async function listLogs(client: { get(path: string): Promise<Response> }, query: URLSearchParams) {
  const res = await client.get(`/audit/logs?${query.toString()}`);
  return { status: res.status, body: await res.json().then((json: unknown) => json) };
}

describe('Audit log access', () => {
  it('admin with the audit permission lists logs filtered by actor, action and day range', async () => {
    const admin = await newSuperAdmin();
    const actorId = `trail-${randomUUID()}`;
    await queueTrailRows([
      { actorId, action: 'trail.alpha', createdAt: '2019-03-10T08:00:00.000Z' },
      { actorId, action: 'trail.alpha', createdAt: '2019-03-10T20:00:00.000Z' },
      { actorId, action: 'trail.beta', createdAt: '2019-03-10T09:00:00.000Z' },
      { actorId, action: 'trail.alpha', createdAt: '2019-03-15T09:00:00.000Z' },
      {
        actorId: `trail-${randomUUID()}`,
        action: 'trail.alpha',
        createdAt: '2019-03-10T10:00:00.000Z',
      },
    ]);

    const { status, body } = await listLogs(
      admin.client,
      new URLSearchParams({
        actorId,
        action: 'trail.alpha',
        fromDate: '2019-03-10',
        toDate: '2019-03-12',
        limit: '50',
      }),
    );

    expect(status).toBe(200);
    const page = LogPageSchema.parse(body);
    expect(page.total).toBe(2);
    expect(page.items.map((item) => item.createdAt).sort()).toEqual([
      '2019-03-10T08:00:00.000Z',
      '2019-03-10T20:00:00.000Z',
    ]);
    expect(
      page.items.every((item) => item.actorId === actorId && item.action === 'trail.alpha'),
    ).toBe(true);
  });

  it('admin day-range filter includes the whole start and end days in UTC', async () => {
    const admin = await newSuperAdmin();
    const actorId = `trail-${randomUUID()}`;
    await queueTrailRows([
      { actorId, action: 'trail.edge', createdAt: '2019-06-09T23:59:59.999Z' },
      { actorId, action: 'trail.edge', createdAt: '2019-06-10T00:00:00.000Z' },
      { actorId, action: 'trail.edge', createdAt: '2019-06-11T23:59:59.999Z' },
      { actorId, action: 'trail.edge', createdAt: '2019-06-12T00:00:00.000Z' },
    ]);

    const { status, body } = await listLogs(
      admin.client,
      new URLSearchParams({ actorId, fromDate: '2019-06-10', toDate: '2019-06-11', limit: '50' }),
    );

    expect(status).toBe(200);
    const page = LogPageSchema.parse(body);
    expect(page.items.map((item) => item.createdAt).sort()).toEqual([
      '2019-06-10T00:00:00.000Z',
      '2019-06-11T23:59:59.999Z',
    ]);
  });

  it('admin exports the filtered logs as csv and the csv matches the list', async () => {
    const admin = await newSuperAdmin();
    const actorId = `trail-${randomUUID()}`;
    await queueTrailRows([
      { actorId, action: 'trail.export', createdAt: '2019-09-01T08:00:00.000Z' },
      { actorId, action: 'trail.export', createdAt: '2019-09-02T08:00:00.000Z' },
      { actorId, action: 'trail.export', createdAt: '2019-09-03T08:00:00.000Z' },
      { actorId, action: 'trail.other', createdAt: '2019-09-02T09:00:00.000Z' },
    ]);
    const filters = new URLSearchParams({
      actorId,
      action: 'trail.export',
      fromDate: '2019-09-01',
      toDate: '2019-09-03',
    });

    const listed = await listLogs(
      admin.client,
      new URLSearchParams({ ...Object.fromEntries(filters), sortOrder: 'asc', limit: '50' }),
    );
    const exported = await admin.client.get(`/audit/export?${filters.toString()}`);

    expect(exported.status).toBe(200);
    const { csv } = z.object({ csv: z.string() }).parse(await exported.json());
    const [header, ...lines] = csv.split('\n');
    expect(header).toBe(
      'id,actorId,actorType,action,resourceType,resourceId,ip,correlationId,result,seq,prevHash,hash,createdAt',
    );
    const page = LogPageSchema.parse(listed.body);
    expect(page.items).toHaveLength(3);
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => line.split(',')[0])).toEqual(
      page.items.map((item) => `"${item.id}"`),
    );
    expect(lines.map((line) => line.split(',').at(-1))).toEqual(
      page.items.map((item) => `"${item.createdAt}"`),
    );
  });

  it.todo(
    'GAP: export with fromDate after toDate returns 200 with no rows instead of a validation error (packages/core/src/audit/contract/index.ts:72)',
  );
  it('player cannot list or export audit logs', async () => {
    const player = await newPlayer(e2e.app, 'audit-trail-player');

    const list = await player.client.get('/audit/logs');
    const exported = await player.client.get('/audit/export');

    expect(list.status).toBe(403);
    expect(exported.status).toBe(403);
  });

  it('player reads only own responsible-gambling history ordered by sort direction', async () => {
    const player = await newRgPlayer(e2e);
    const other = await newRgPlayer(e2e);
    await putLimit(player.client, player.currency, { amount: '100' });
    await putLimit(player.client, player.currency, { amount: '50' });
    await putLimit(other.client, other.currency, { amount: '70' });
    await flushAudit(e2e.app);

    const asc = HistoryPageSchema.parse(
      (await readBody(await player.client.get('/audit/me/rg-history?sortOrder=asc'))).body,
    );
    const desc = HistoryPageSchema.parse(
      (await readBody(await player.client.get('/audit/me/rg-history?sortOrder=desc'))).body,
    );

    expect(asc.total).toBe(2);
    expect(asc.items.map((item) => item.newAmount)).toEqual([
      '100.000000000000000000',
      '50.000000000000000000',
    ]);
    expect(desc.items.map((item) => item.newAmount)).toEqual([
      '50.000000000000000000',
      '100.000000000000000000',
    ]);
    expect(desc.items.map((item) => item.id)).toEqual(asc.items.map((item) => item.id).reverse());
  });

  it('player cannot read another player history through the route', async () => {
    const owner = await newRgPlayer(e2e);
    const snoop = await newRgPlayer(e2e);
    await putLimit(owner.client, owner.currency, { amount: '100' });
    await flushAudit(e2e.app);

    const probe = new URLSearchParams({
      userId: owner.userId,
      playerId: owner.playerId,
      resourceId: owner.playerId,
    });
    const res = await snoop.client.get(`/audit/me/rg-history?${probe.toString()}`);

    expect(res.status).toBe(200);
    const page = HistoryPageSchema.parse(await res.json());
    expect(page).toMatchObject({ total: 0, items: [] });
  });

  it('rows still waiting in the outbox appear in reads before the shipper drains', async () => {
    const player = await newRgPlayer(e2e);

    await db().transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('audit_shipper'))`);
      await putLimit(player.client, player.currency, { amount: '100' });

      const queued = await tx
        .select({ id: auditOutbox.id })
        .from(auditOutbox)
        .where(
          sql`${auditOutbox.entry}->>'resourceId' = ${player.playerId} AND ${auditOutbox.entry}->>'action' = 'rg.limit.set'`,
        );
      const chained = await tx
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(and(eq(auditLog.resourceId, player.playerId), eq(auditLog.action, 'rg.limit.set')));
      const res = await player.client.get('/audit/me/rg-history');
      const page = HistoryPageSchema.parse(await res.json());

      expect(queued).toHaveLength(1);
      expect(chained).toHaveLength(0);
      const queuedItems = page.items.filter((item) => item.action === 'rg.limit.set');
      expect(queuedItems).toHaveLength(1);
      expect(queuedItems[0]).toMatchObject({ newAmount: '100.000000000000000000' });
    });

    await flushAudit(e2e.app);
    const drained = HistoryPageSchema.parse(
      await (await player.client.get('/audit/me/rg-history')).json(),
    );
    const drainedItems = drained.items.filter((item) => item.action === 'rg.limit.set');
    expect(drainedItems).toHaveLength(1);
    expect(drainedItems[0]?.newAmount).toBe('100.000000000000000000');
  });
});

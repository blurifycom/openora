import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { DRIZZLE } from '@openora/core/server';
import { auditLog } from '@openora/core/audit/schema';
import { flushAudit, newPlayer, newStaff } from '../index.js';
import { bootWalletE2e, closeWalletE2e, type WalletE2e } from './support/wallet.js';

let e2e: WalletE2e;

beforeAll(async () => {
  e2e = await bootWalletE2e([
    {
      id: 'testing-admin-mutation',
      path: fileURLToPath(new URL('./support/test-admin-mutation-plugin.ts', import.meta.url)),
    },
  ]);
}, 60_000);

afterAll(() => closeWalletE2e(e2e));

const FALLBACK_ACTION = 'admin.content.update';

const mutationBody = (overrides: Record<string, unknown> = {}) => ({
  targetId: randomUUID(),
  note: `note ${randomUUID()}`,
  ...overrides,
});

async function auditRowsFor(actorId: string) {
  await flushAudit(e2e.app);
  return e2e.app.container
    .get(DRIZZLE)
    .db.select()
    .from(auditLog)
    .where(eq(auditLog.actorId, actorId))
    .orderBy(asc(auditLog.seq));
}

const newAdmin = () => newStaff(e2e.app, 'mutation-audit', 'super-admin');

describe('admin mutation audit fallback', () => {
  it('an admin mutation that writes no audit row leaves one admin resource action row with the route and actor', async () => {
    const admin = await newAdmin();
    const body = mutationBody();

    const res = await admin.client.post('/testing/admin-mutation/silent', body);

    expect(res.status).toBe(200);
    const rows = await auditRowsFor(admin.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorId: admin.userId,
      actorType: 'admin',
      action: FALLBACK_ACTION,
      resourceType: 'content',
      resourceId: body.targetId,
      result: 'success',
      after: expect.objectContaining({
        route: expect.stringContaining('silent'),
        inputKeys: ['note', 'targetId'],
      }),
    });
  });

  it('an admin mutation that writes its own audit row leaves no second row', async () => {
    const admin = await newAdmin();

    const res = await admin.client.post('/testing/admin-mutation/own-audit', mutationBody());

    expect(res.status).toBe(200);
    const rows = await auditRowsFor(admin.userId);
    expect(rows.map((row) => row.action)).toEqual(['testing.admin_mutation.own_audit']);
  });

  it('a failed admin mutation leaves a failure audit row for the actor', async () => {
    const admin = await newAdmin();

    const res = await admin.client.post('/testing/admin-mutation/failing', mutationBody());

    expect(res.status).toBe(409);
    const rows = await auditRowsFor(admin.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorId: admin.userId,
      actorType: 'admin',
      action: FALLBACK_ACTION,
      result: 'failure',
      after: expect.objectContaining({ errorCode: 'CONFLICT' }),
    });
  });

  it('an admin read leaves no audit row', async () => {
    const admin = await newAdmin();

    const res = await admin.client.get('/testing/admin-mutation/read');

    expect(res.status).toBe(200);
    expect(await auditRowsFor(admin.userId)).toHaveLength(0);
  });

  it('a player calling an admin mutation is refused and leaves no admin audit row', async () => {
    const player = await newPlayer(e2e.app, 'mutation-audit-player');
    const body = mutationBody();

    const res = await player.client.post('/testing/admin-mutation/silent', body);

    expect(res.status).toBe(403);
    const rows = await auditRowsFor(player.userId);
    expect(rows.filter((row) => row.action.startsWith('admin.'))).toHaveLength(0);
    expect(rows.filter((row) => row.actorType === 'admin')).toHaveLength(0);
  });
});

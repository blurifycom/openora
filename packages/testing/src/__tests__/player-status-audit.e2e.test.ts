import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '@openora/core/server';
import { user } from '@openora/core/pam/schema/identity';
import {
  asAdmin,
  registerAndMaterializePlayer,
  type TestApp,
  type TestClient,
  type TestDb,
  uniqueUsername,
  bootE2e,
  closeE2e,
} from '../index.js';

type AuditItem = {
  action: string;
  actorType: string;
  actorId: string | null;
  resourceType: string;
  resourceId: string | null;
  before: unknown;
  after: unknown;
};

let db: TestDb;
let testApp: TestApp;
let admin: TestClient;
let adminUserId: string;

async function statusChanges(playerId: string): Promise<AuditItem[]> {
  const res = await admin.get(
    `/audit/logs?resourceType=player&resourceId=${playerId}&action=player.status.changed&sortOrder=asc`,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: AuditItem[] };
  return body.items;
}

beforeAll(async () => {
  ({ db, app: testApp } = await bootE2e());
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
  await closeE2e({ app: testApp, db });
});

describe('player status change audit', () => {
  it('records each admin suspend and reactivate against the player', async () => {
    const { playerId } = await registerAndMaterializePlayer(testApp, {
      email: `status-audit-${randomUUID()}@e2e.test`,
    });

    expect((await admin.patch(`/players/${playerId}`, { status: 'suspended' })).status).toBe(200);
    expect((await admin.patch(`/players/${playerId}`, { status: 'active' })).status).toBe(200);

    await vi.waitFor(async () => {
      expect(await statusChanges(playerId)).toEqual([
        expect.objectContaining({
          actorType: 'admin',
          actorId: adminUserId,
          resourceType: 'player',
          resourceId: playerId,
          before: { status: 'active' },
          after: { status: 'suspended' },
        }),
        expect.objectContaining({
          actorType: 'admin',
          actorId: adminUserId,
          before: { status: 'suspended' },
          after: { status: 'active' },
        }),
      ]);
    });
  });

  it('records no status change for a denied, unchanged, or username-only update', async () => {
    const { client, playerId } = await registerAndMaterializePlayer(testApp, {
      email: `status-audit-noop-${randomUUID()}@e2e.test`,
    });

    expect((await client.patch(`/players/${playerId}`, { status: 'suspended' })).status).toBe(403);
    expect((await admin.patch(`/players/${playerId}`, { status: 'active' })).status).toBe(200);
    expect(
      (await admin.patch(`/players/${playerId}`, { username: uniqueUsername('u') })).status,
    ).toBe(200);
    // Audit rows land in order, so waiting on this transition's row also covers the earlier calls.
    expect((await admin.patch(`/players/${playerId}`, { status: 'suspended' })).status).toBe(200);

    await vi.waitFor(async () => {
      expect(await statusChanges(playerId)).toEqual([
        expect.objectContaining({
          before: { status: 'active' },
          after: { status: 'suspended' },
        }),
      ]);
    });
  });
});

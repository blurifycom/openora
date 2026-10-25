import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, like, sql } from 'drizzle-orm';
import { DRIZZLE } from '@openora/core/server';
import { auditLog } from '@openora/core/audit/schema';
import { game, gameProvider } from '@openora/core/casino/schema/gaming';
import { user } from '@openora/core/pam/schema/identity';
import {
  asAdmin,
  registerAndMaterializePlayer,
  uniqueUsername,
  type TestApp,
  type TestClient,
  type TestDb,
  bootE2e,
  closeE2e,
} from '../index.js';

let db: TestDb;
let testApp: TestApp;
let admin: TestClient;
let adminUserId: string;
let activeGameId: string;
let inactiveGameId: string;

const drizzle = () => testApp.container.get(DRIZZLE).db;

const fallbackRows = (action?: string) =>
  drizzle()
    .select()
    .from(auditLog)
    .where(like(auditLog.action, action ?? 'admin.%'))
    .orderBy(auditLog.seq);

async function seedGame(isActive: boolean) {
  const [provider] = await drizzle()
    .insert(gameProvider)
    .values({ slug: `fallback-audit-${randomUUID()}`, name: 'Fallback Audit', isActive: true })
    .returning();
  const [created] = await drizzle()
    .insert(game)
    .values({
      reviewStatus: 'approved',
      name: 'Fallback Audit Game',
      slug: `fallback-audit-game-${randomUUID()}`,
      providerId: provider!.id,
      aggregator: 'direct',
      isActive,
    })
    .returning();
  return created!.id;
}

beforeAll(async () => {
  ({ db, app: testApp } = await bootE2e());
  admin = await asAdmin(testApp.app);
  const [account] = await drizzle()
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, 'admin@oss.dev'));
  adminUserId = account!.id;
  activeGameId = await seedGame(true);
  inactiveGameId = await seedGame(false);
}, 60_000);

afterAll(async () => {
  await closeE2e({ app: testApp, db });
});

describe('fallback audit for admin mutations', () => {
  it('writes exactly one record for an admin mutation that audits nothing itself', async () => {
    // Already active: the bulk write changes nothing, so it appends no audit row of its own.
    const res = await admin.post('/backoffice/gaming/games/bulk/active', {
      gameIds: [activeGameId],
      isActive: true,
    });
    expect(res.status).toBe(200);

    expect(await fallbackRows('admin.game-config.update')).toEqual([
      expect.objectContaining({
        actorType: 'admin',
        actorId: adminUserId,
        resourceType: 'game-config',
        resourceId: null,
        result: 'success',
        after: {
          route: 'gaming.setGamesActive',
          input: { gameIds: [activeGameId], isActive: true },
        },
      }),
    ]);
  });

  it('writes nothing extra when the mutation already audits', async () => {
    const before = (await fallbackRows()).length;
    const countRows = async () =>
      (
        await drizzle()
          .select({ n: sql<number>`count(*)::int` })
          .from(auditLog)
      )[0]!.n;
    const rowsBefore = await countRows();

    const res = await admin.post('/backoffice/gaming/games/bulk/active', {
      gameIds: [inactiveGameId],
      isActive: true,
    });
    expect(res.status).toBe(200);

    // The event subscriber appends its row after the response, so wait for it before checking
    // that the fallback added nothing beside it.
    await vi.waitFor(async () => expect(await countRows()).toBe(rowsBefore + 1));
    expect(await fallbackRows()).toHaveLength(before);
  });

  it('records a failed mutation with its error code and the input, secrets redacted', async () => {
    const pageId = randomUUID();
    const res = await admin.put(`/cms/pages/${pageId}`, {
      title: 'Missing page',
      content: { body: 'visible', apiKey: 'sk_live_do_not_store', nested: { password: 'hunter2' } },
    });
    expect(res.status).toBe(404);

    const rows = await fallbackRows('admin.content.update');
    expect(rows).toEqual([
      expect.objectContaining({
        actorType: 'admin',
        actorId: adminUserId,
        resourceType: 'content',
        resourceId: pageId,
        result: 'failure',
        after: {
          route: 'cms.updatePage',
          errorCode: 'NOT_FOUND',
          input: {
            id: pageId,
            title: 'Missing page',
            content: { body: 'visible', apiKey: '[redacted]', nested: { password: '[redacted]' } },
          },
        },
      }),
    ]);
    const leaked = await drizzle()
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        sql`${auditLog.after}::text LIKE '%sk_live_do_not_store%' OR ${auditLog.after}::text LIKE '%hunter2%'`,
      );
    expect(leaked).toEqual([]);
  });

  it('writes nothing for an admin read, a player mutation, or a denied admin call', async () => {
    const before = (await fallbackRows()).length;
    const { client, playerId } = await registerAndMaterializePlayer(testApp, {
      email: `fallback-audit-${randomUUID()}@e2e.test`,
    });

    expect((await admin.get('/backoffice/gaming/games?page=1&limit=5')).status).toBe(200);
    // A POST under a `view` grant is a search, not an intervention.
    expect(
      (await admin.post('/backoffice/gaming/games/search', { page: 1, limit: 5 })).status,
    ).toBe(200);
    expect((await client.patch('/profile', { username: uniqueUsername('fb') })).status).toBe(200);
    expect((await client.patch(`/players/${playerId}`, { status: 'suspended' })).status).toBe(403);

    expect(await fallbackRows()).toHaveLength(before);
    const byPlayer = await drizzle()
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(like(auditLog.action, 'admin.%'), eq(auditLog.actorType, 'player')));
    expect(byPlayer).toEqual([]);
  });
});

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  loadExtensions,
  DRIZZLE,
  type Container,
  type CoreTokenCatalog,
} from '@openora/core/server';
import { game, gameProvider, gameTagGame } from '@openora/core/casino/schema/gaming';
import {
  asAdmin,
  asPlayer,
  bootTestApp,
  seedMinimal,
  setupTestDb,
  type TestApp,
  type TestClient,
  type TestDb,
} from '../index.js';

let db: TestDb;
let app: TestApp;
let admin: TestClient;
let player: TestClient;

// oxlint-disable-next-line typescript/no-explicit-any -- ad-hoc JSON shape assertions in tests
async function readJson(res: Response): Promise<any> {
  return res.json();
}

function drizzleOf(container: Container<CoreTokenCatalog>) {
  return container.get(DRIZZLE).db;
}

async function seedProvider(overrides: Partial<typeof gameProvider.$inferInsert> = {}) {
  const [row] = await drizzleOf(app.container)
    .insert(gameProvider)
    .values({
      slug: `e2e-bulk-provider-${randomUUID()}`,
      name: 'E2E Bulk Provider',
      isActive: true,
      ...overrides,
    })
    .returning();
  if (!row) {
    throw new Error('failed to seed a game provider');
  }
  return row;
}

async function seedGame(providerId: string, overrides: Partial<typeof game.$inferInsert> = {}) {
  const [row] = await drizzleOf(app.container)
    .insert(game)
    .values({
      name: 'E2E Bulk Game',
      slug: `e2e-bulk-game-${randomUUID()}`,
      providerId,
      aggregator: 'direct',
      isActive: true,
      ...overrides,
    })
    .returning();
  if (!row) {
    throw new Error('failed to seed a game');
  }
  return row;
}

async function gameRow(gameId: string) {
  const [row] = await drizzleOf(app.container).select().from(game).where(eq(game.id, gameId));
  return row;
}

async function tagIdsFor(gameId: string) {
  const rows = await drizzleOf(app.container)
    .select({ tagId: gameTagGame.tagId })
    .from(gameTagGame)
    .where(eq(gameTagGame.gameId, gameId));
  return rows.map((r) => r.tagId).sort();
}

async function bulkAuditEntriesFor(gameId: string) {
  const res = await admin.get(
    `/audit/logs?action=${encodeURIComponent('gaming.games.bulk_updated')}&resourceType=game&limit=100&sortOrder=desc`,
  );
  expect(res.status).toBe(200);
  const body = await readJson(res);
  return (
    body.items as Array<{
      actorType: string;
      actorId: string | null;
      resourceType: string;
      resourceId: string | null;
      after: {
        changedGameIds?: string[];
        addedLinks?: Array<{ gameId: string }>;
        operation?: string;
        bulkOperationId?: string;
      };
      correlationId: string | null;
    }>
  ).filter(
    (entry) =>
      entry.after?.changedGameIds?.includes(gameId) ||
      entry.after?.addedLinks?.some((link) => link.gameId === gameId),
  );
}

async function waitForBulkAuditCount(gameId: string, expected: number) {
  await vi.waitFor(async () => {
    const entries = await bulkAuditEntriesFor(gameId);
    expect(entries).toHaveLength(expected);
  });
}

async function waitForLaterBulkAuditRow(providerId: string) {
  const laterGame = await seedGame(providerId, { isActive: false });
  const res = await admin.post('/backoffice/gaming/games/bulk/active', {
    gameIds: [laterGame.id],
    isActive: true,
  });
  expect(res.status).toBe(200);
  await waitForBulkAuditCount(laterGame.id, 1);
}

async function providerAuditEntriesFor(providerId: string) {
  const res = await admin.get(
    `/audit/logs?action=${encodeURIComponent('gaming.provider.updated')}&resourceType=game_provider&resourceId=${providerId}&limit=100&sortOrder=desc`,
  );
  expect(res.status).toBe(200);
  const body = await readJson(res);
  return body.items as Array<{
    actorType: string;
    actorId: string | null;
    resourceType: string;
    resourceId: string | null;
    // oxlint-disable-next-line typescript/no-explicit-any -- ad-hoc JSON shape assertions
    before: any;
    // oxlint-disable-next-line typescript/no-explicit-any -- ad-hoc JSON shape assertions
    after: any;
    correlationId: string | null;
  }>;
}

async function waitForProviderAuditCount(providerId: string, expected: number) {
  await vi.waitFor(async () => {
    const entries = await providerAuditEntriesFor(providerId);
    expect(entries).toHaveLength(expected);
  });
}

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['WITHDRAWAL_PIN_HMAC_SECRET'] ??= 'e2e-test-withdrawal-pin-hmac-secret-000000';
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  app = await bootTestApp({ plugins: await loadExtensions(), databaseUrl: db.url });
  await seedMinimal(app.container, { playerCount: 1 });
  admin = await asAdmin(app.app);
  player = await asPlayer(app.app, { email: 'player.1@demo.igaming.dev' });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.dispose();
});

describe('gaming bulk catalog actions e2e', () => {
  it('denies bulk/active to a player without game-config permission and to an unauthenticated caller', async () => {
    const provider = await seedProvider();
    const target = await seedGame(provider.id);

    const forbidden = await player.post('/backoffice/gaming/games/bulk/active', {
      gameIds: [target.id],
      isActive: false,
    });
    expect(forbidden.status).toBe(403);

    const unauthenticated = await app.app.request('/backoffice/gaming/games/bulk/active', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gameIds: [target.id], isActive: false }),
    });
    expect(unauthenticated.status).toBe(401);

    expect((await gameRow(target.id))?.isActive).toBe(true);
  });

  it('rejects a target naming neither gameIds nor providerIds', async () => {
    const res = await admin.post('/backoffice/gaming/games/bulk/tags', {
      tagIds: [randomUUID()],
    });
    expect(res.status).toBe(400);
  });

  it(
    'bulkSetGamesActive flips games by gameIds and providerIds, counts an overlap once, ' +
      'reports notFound, flags a still-inactive-provider game as unplayable, writes exactly ' +
      'one audit row, is a no-op on repeat, and public reads reflect the change',
    async () => {
      const providerA = await seedProvider({ isActive: false });
      const providerB = await seedProvider({ isActive: false });
      const providerC = await seedProvider();
      const gA1 = await seedGame(providerA.id, { isActive: false });
      const gA2 = await seedGame(providerA.id, { isActive: false });
      const gB1 = await seedGame(providerB.id, { isActive: false });
      const untouched = await seedGame(providerC.id, { isActive: false });
      const ghostGameId = randomUUID();

      const activateRes = await admin.post('/backoffice/gaming/games/bulk/active', {
        gameIds: [gA1.id, gB1.id, ghostGameId],
        providerIds: [providerA.id],
        isActive: true,
      });
      expect(activateRes.status).toBe(200);
      const activateBody = await readJson(activateRes);
      expect(activateBody).toEqual({
        games: { updatedCount: 3, unchangedCount: 0 },
        providers: { updatedCount: 1, unchangedCount: 0 },
        notFound: { gameIds: [ghostGameId], providerIds: [] },
        unplayableGameIds: [gB1.id],
      });

      expect((await gameRow(gA1.id))?.isActive).toBe(true);
      expect((await gameRow(gA2.id))?.isActive).toBe(true);
      expect((await gameRow(gB1.id))?.isActive).toBe(true);
      expect((await gameRow(untouched.id))?.isActive).toBe(false);

      const publicPlayable = await app.app.request(`/gaming/games/${gA1.id}`);
      expect(publicPlayable.status).toBe(200);
      const publicUnplayable = await app.app.request(`/gaming/games/${gB1.id}`);
      expect(publicUnplayable.status).toBe(404);

      const publicList = await app.app.request(`/gaming/games?page=1&limit=100`);
      const listedIds = (await readJson(publicList)).items.map((g: { id: string }) => g.id);
      expect(listedIds).toContain(gA1.id);
      expect(listedIds).not.toContain(gB1.id);
      expect(listedIds).not.toContain(untouched.id);

      await waitForBulkAuditCount(gA1.id, 1);
      const [auditRow] = await bulkAuditEntriesFor(gA1.id);
      expect(auditRow).toMatchObject({
        actorType: 'admin',
        resourceType: 'game',
        resourceId: null,
      });
      expect(auditRow?.actorId).toBeTruthy();
      const summaryBulkOperationId = auditRow?.after?.bulkOperationId;
      expect(summaryBulkOperationId).toEqual(expect.any(String));

      await waitForProviderAuditCount(providerA.id, 1);
      const [providerAuditRow] = await providerAuditEntriesFor(providerA.id);
      expect(providerAuditRow).toMatchObject({
        actorType: 'admin',
        resourceType: 'game_provider',
        resourceId: providerA.id,
        before: expect.objectContaining({ isActive: false }),
        after: expect.objectContaining({ isActive: true }),
      });
      expect(auditRow?.correlationId).toBe(summaryBulkOperationId);
      expect(providerAuditRow?.correlationId).toBe(summaryBulkOperationId);

      const deactivateRes = await admin.post('/backoffice/gaming/games/bulk/active', {
        gameIds: [gA1.id],
        isActive: false,
      });
      expect(deactivateRes.status).toBe(200);
      await waitForBulkAuditCount(gA1.id, 2);

      const repeatRes = await admin.post('/backoffice/gaming/games/bulk/active', {
        gameIds: [gA1.id],
        isActive: false,
      });
      expect(repeatRes.status).toBe(200);
      expect(await readJson(repeatRes)).toEqual({
        games: { updatedCount: 0, unchangedCount: 1 },
        providers: { updatedCount: 0, unchangedCount: 0 },
        notFound: { gameIds: [], providerIds: [] },
        unplayableGameIds: [],
      });

      await waitForLaterBulkAuditRow(providerA.id);
      expect(await bulkAuditEntriesFor(gA1.id)).toHaveLength(2);
    },
  );

  it(
    'bulkAddGameTags is add-only, reports notFound, rejects the whole call on an unknown ' +
      'tagId writing nothing, writes exactly one audit row, and a visible tag shows up publicly',
    async () => {
      const provider = await seedProvider();
      const target = await seedGame(provider.id);
      const existingTagRes = await admin.post('/backoffice/gaming/tags', {
        name: `E2E Bulk Existing ${randomUUID()}`,
      });
      expect(existingTagRes.status).toBe(200);
      const existingTag = await readJson(existingTagRes);
      await admin.patch(`/backoffice/gaming/games/${target.id}`, { tagIds: [existingTag.id] });

      const newTagRes = await admin.post('/backoffice/gaming/tags', {
        name: `E2E Bulk Visible ${randomUUID()}`,
        visibility: 'visible',
      });
      expect(newTagRes.status).toBe(200);
      const newTag = await readJson(newTagRes);
      const ghostGameId = randomUUID();

      const addRes = await admin.post('/backoffice/gaming/games/bulk/tags', {
        gameIds: [target.id, ghostGameId],
        tagIds: [newTag.id],
      });
      expect(addRes.status).toBe(200);
      expect(await readJson(addRes)).toEqual({
        games: { updatedCount: 1, unchangedCount: 0 },
        notFound: { gameIds: [ghostGameId], providerIds: [] },
      });

      const publicGame = await app.app.request(`/gaming/games/${target.id}`);
      expect(publicGame.status).toBe(200);
      const publicBody = await readJson(publicGame);
      expect(publicBody.tags).toHaveLength(1);
      expect(publicBody.tags[0]).toMatchObject({ id: newTag.id, visibility: 'visible' });
      expect(await tagIdsFor(target.id)).toEqual([existingTag.id, newTag.id].sort());

      await waitForBulkAuditCount(target.id, 1);

      const realTagRes = await admin.post('/backoffice/gaming/tags', {
        name: `E2E Bulk Another ${randomUUID()}`,
      });
      const realTag = await readJson(realTagRes);
      const ghostTagId = randomUUID();
      const rejectedRes = await admin.post('/backoffice/gaming/games/bulk/tags', {
        gameIds: [target.id],
        tagIds: [realTag.id, ghostTagId],
      });
      expect(rejectedRes.status).toBe(404);

      await waitForBulkAuditCount(target.id, 1);
      const stillTagged = await app.app.request(`/gaming/games/${target.id}`);
      const stillTaggedBody = await readJson(stillTagged);
      expect(stillTaggedBody.tags).toHaveLength(1);
      expect(stillTaggedBody.tags[0]).toMatchObject({ id: newTag.id, visibility: 'visible' });

      const repeatRes = await admin.post('/backoffice/gaming/games/bulk/tags', {
        gameIds: [target.id],
        tagIds: [newTag.id],
      });
      expect(await readJson(repeatRes)).toEqual({
        games: { updatedCount: 0, unchangedCount: 1 },
        notFound: { gameIds: [], providerIds: [] },
      });
      await waitForBulkAuditCount(target.id, 1);
    },
  );

  it('bulkAddGameTags records only the ids a game was actually missing on a partial overlap', async () => {
    const provider = await seedProvider();
    const partial = await seedGame(provider.id);
    const fresh = await seedGame(provider.id);
    const tagARes = await admin.post('/backoffice/gaming/tags', {
      name: `E2E Bulk Partial A ${randomUUID()}`,
    });
    const tagBRes = await admin.post('/backoffice/gaming/tags', {
      name: `E2E Bulk Partial B ${randomUUID()}`,
    });
    const tagA = await readJson(tagARes);
    const tagB = await readJson(tagBRes);
    await admin.patch(`/backoffice/gaming/games/${partial.id}`, { tagIds: [tagA.id] });

    const res = await admin.post('/backoffice/gaming/games/bulk/tags', {
      gameIds: [partial.id, fresh.id],
      tagIds: [tagA.id, tagB.id],
    });
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({
      games: { updatedCount: 2, unchangedCount: 0 },
      notFound: { gameIds: [], providerIds: [] },
    });
    expect(await tagIdsFor(partial.id)).toEqual([tagA.id, tagB.id].sort());
    expect(await tagIdsFor(fresh.id)).toEqual([tagA.id, tagB.id].sort());

    await waitForBulkAuditCount(partial.id, 1);
    const [auditRow] = await bulkAuditEntriesFor(partial.id);
    const expectedAddedLinks = [
      { gameId: partial.id, tagIds: [tagB.id] },
      { gameId: fresh.id, tagIds: [tagA.id, tagB.id].sort() },
    ].sort((a, b) => (a.gameId < b.gameId ? -1 : a.gameId > b.gameId ? 1 : 0));
    expect(auditRow?.after?.addedLinks).toEqual(expectedAddedLinks);
  });

  it('bulk/active, bulk/tags and bulk/categories all cap a single call at 5000 matched games', async () => {
    const provider = await seedProvider();
    const rows = await drizzleOf(app.container)
      .insert(game)
      .values(
        Array.from({ length: 5001 }, () => ({
          name: 'E2E Bulk Cap Game',
          slug: `e2e-bulk-cap-game-${randomUUID()}`,
          providerId: provider.id,
          aggregator: 'direct',
          isActive: true,
        })),
      )
      .returning({ id: game.id });
    const anchorGameId = rows[0]!.id;

    const capTagRes = await admin.post('/backoffice/gaming/tags', {
      name: `E2E Bulk Cap Tag ${randomUUID()}`,
    });
    const capTag = await readJson(capTagRes);

    const overCapRes = await admin.post('/backoffice/gaming/games/bulk/tags', {
      providerIds: [provider.id],
      tagIds: [capTag.id],
    });
    expect(overCapRes.status).toBe(400);
    expect(await tagIdsFor(anchorGameId)).toEqual([]);

    const overCapActiveRes = await admin.post('/backoffice/gaming/games/bulk/active', {
      providerIds: [provider.id],
      isActive: false,
    });
    expect(overCapActiveRes.status).toBe(400);
    expect((await gameRow(anchorGameId))?.isActive).toBe(true);
  }, 30_000);

  it('bulkAddGameCategories is add-only, reports notFound, and rejects the whole call on an unknown categoryId writing nothing', async () => {
    const provider = await seedProvider();
    const target = await seedGame(provider.id);
    const existingCategoryRes = await admin.post('/backoffice/gaming/categories', {
      slug: `e2e-bulk-existing-${randomUUID()}`,
      name: 'E2E Bulk Existing Category',
    });
    const existingCategory = await readJson(existingCategoryRes);
    await admin.patch(`/backoffice/gaming/games/${target.id}`, {
      categoryIds: [existingCategory.id],
    });

    const newCategoryRes = await admin.post('/backoffice/gaming/categories', {
      slug: `e2e-bulk-new-${randomUUID()}`,
      name: 'E2E Bulk New Category',
    });
    const newCategory = await readJson(newCategoryRes);
    const ghostProviderId = randomUUID();

    const addRes = await admin.post('/backoffice/gaming/games/bulk/categories', {
      gameIds: [target.id],
      providerIds: [ghostProviderId],
      categoryIds: [newCategory.id],
    });
    expect(addRes.status).toBe(200);
    expect(await readJson(addRes)).toEqual({
      games: { updatedCount: 1, unchangedCount: 0 },
      notFound: { gameIds: [], providerIds: [ghostProviderId] },
    });

    const publicGame = await app.app.request(`/gaming/games/${target.id}`);
    const categoryIds = (await readJson(publicGame)).categories.map((c: { id: string }) => c.id);
    expect(categoryIds.sort()).toEqual([existingCategory.id, newCategory.id].sort());

    await waitForBulkAuditCount(target.id, 1);

    const ghostCategoryId = randomUUID();
    const rejectedRes = await admin.post('/backoffice/gaming/games/bulk/categories', {
      gameIds: [target.id],
      categoryIds: [ghostCategoryId],
    });
    expect(rejectedRes.status).toBe(404);

    await waitForBulkAuditCount(target.id, 1);
    const stillCategorized = await app.app.request(`/gaming/games/${target.id}`);
    const categoryIdsAfter = (await readJson(stillCategorized)).categories.map(
      (c: { id: string }) => c.id,
    );
    expect(categoryIdsAfter.sort()).toEqual([existingCategory.id, newCategory.id].sort());
  });
});

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import * as z from 'zod';
import { DRIZZLE, loadExtensions } from '@openora/core/server';
import { auditLog } from '@openora/core/audit/schema';
import {
  game,
  gameCategory,
  gameCategoryGame,
  gameProvider,
  gameTag,
  gameTagGame,
} from '@openora/core/casino/schema/gaming';
import { adminRole, adminRolePermission } from '@openora/core/iam/schema';
import {
  asAdmin,
  assignIamRoleByKey,
  bootE2e,
  closeE2e,
  flushAudit,
  newPlayer,
  newStaff,
  type E2e,
  type TestClient,
} from '../index.js';
import { bodyOf, newGame } from './support/casino.js';
import {
  BROAD_MATCH_COUNT,
  scriptBroadMatch,
  scriptedRule,
  scriptFailure,
  scriptMatches,
} from './support/test-scripted-rule-plugin.js';

type CatalogE2e = E2e & { admin: TestClient };

let e2e: CatalogE2e;

beforeAll(async () => {
  const booted = await bootE2e({
    plugins: [
      ...(await loadExtensions()),
      {
        id: 'test-scripted-rule',
        path: fileURLToPath(new URL('./support/test-scripted-rule-plugin.ts', import.meta.url)),
      },
    ],
  });
  try {
    e2e = { ...booted, admin: await asAdmin(booted.app.app) };
  } catch (err) {
    await closeE2e(booted);
    throw err;
  }
}, 120_000);

afterAll(() => closeE2e(e2e));

const db = () => e2e.app.container.get(DRIZZLE).db;

const ErrorSchema = z.object({ code: z.string(), status: z.number() });
const CategorySchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  isActive: z.boolean(),
  sortKey: z.string(),
  membershipMode: z.string(),
  membershipRule: z.unknown(),
  membershipLastError: z.string().nullable(),
});
const PageSchema = z.object({ items: z.array(z.object({ slug: z.string() })) });
const EvaluationSchema = z.object({
  matchedCount: z.number(),
  addedCount: z.number(),
  removedCount: z.number(),
});
const PreviewSchema = z.object({
  total: z.number(),
  items: z.array(z.object({ id: z.string() })),
});

const sorted = <T>(values: readonly T[]) => [...values].sort();

const slugOf = (prefix: string) => `${prefix}-${randomUUID()}`;

async function createCategory(client: TestClient, overrides: Record<string, unknown> = {}) {
  const slug = typeof overrides['slug'] === 'string' ? overrides['slug'] : slugOf('cat');
  const res = await client.post('/backoffice/gaming/categories', {
    name: 'Catalog Category',
    ...overrides,
    slug,
  });
  return { res, slug };
}

async function newCategory(overrides: Record<string, unknown> = {}) {
  const { res } = await createCategory(e2e.admin, overrides);
  if (res.status !== 200) {
    throw new Error(`category create failed (${res.status}): ${await res.text()}`);
  }
  return CategorySchema.parse(await bodyOf(res));
}

async function newRuleCategory(name: string, gameIds: string[]) {
  scriptMatches(name, gameIds);
  return newCategory({ membershipMode: 'rule', membershipRule: scriptedRule(name) });
}

const memberIdsOf = async (categoryId: string) =>
  (
    await db()
      .select({ gameId: gameCategoryGame.gameId })
      .from(gameCategoryGame)
      .where(eq(gameCategoryGame.categoryId, categoryId))
  ).map((row) => row.gameId);

const categoryRowsBySlug = (slug: string) =>
  db().select().from(gameCategory).where(eq(gameCategory.slug, slug));

async function auditRows(action: string, resourceId: string) {
  return vi.waitFor(
    async () => {
      await flushAudit(e2e.app);
      const rows = await db()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, action), eq(auditLog.resourceId, resourceId)));
      expect(rows.length).toBeGreaterThan(0);
      return rows;
    },
    { timeout: 10_000, interval: 100 },
  );
}

async function staffWithoutReporting() {
  const key = `cfg-only-${randomUUID()}`;
  const [role] = await db()
    .insert(adminRole)
    .values({ key, name: 'Game config only' })
    .returning({ id: adminRole.id });
  if (!role) {
    throw new Error('role seed failed');
  }
  await db()
    .insert(adminRolePermission)
    .values({ roleId: role.id, resource: 'game-config', level: 'read_write' });
  const staff = await newPlayer(e2e.app, 'cfg-only');
  await assignIamRoleByKey(e2e.app.container, staff.userId, key);
  return staff;
}

describe('admin manages game categories and rules', () => {
  it('an admin creates a category with a unique slug and it shows in the public category list', async () => {
    const slug = slugOf('public-cat');

    const { res } = await createCategory(e2e.admin, { slug, name: 'Public Cat' });

    expect(res.status).toBe(200);
    const created = CategorySchema.parse(await bodyOf(res));
    expect(created).toMatchObject({
      slug,
      name: 'Public Cat',
      isActive: true,
      membershipMode: 'manual',
    });
    const single = await e2e.app.app.request(`/gaming/categories/${slug}`);
    expect(single.status).toBe(200);
    expect(z.object({ slug: z.string(), name: z.string() }).parse(await bodyOf(single))).toEqual(
      expect.objectContaining({ slug, name: 'Public Cat' }),
    );
    const list = await e2e.app.app.request('/gaming/categories?limit=100');
    expect(list.status).toBe(200);
    expect(PageSchema.parse(await bodyOf(list)).items.map((item) => item.slug)).toContain(slug);
    expect(await categoryRowsBySlug(slug)).toHaveLength(1);
  });

  it('creating a category with a slug already in use is refused with a conflict', async () => {
    const first = await newCategory({ name: 'Original' });

    const { res } = await createCategory(e2e.admin, { slug: first.slug, name: 'Impostor' });

    expect(res.status).toBe(409);
    expect(ErrorSchema.parse(await bodyOf(res)).code).toBe('CONFLICT');
    const rows = await categoryRowsBySlug(first.slug);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('Original');
  });

  it('an admin updates a category and the change is audited', async () => {
    const staff = await newStaff(e2e.app, 'cat-editor', 'casino-manager');
    const created = await newCategory({ name: 'Before Rename' });

    const res = await staff.client.patch(`/backoffice/gaming/categories/${created.id}`, {
      name: 'After Rename',
      isActive: false,
    });

    expect(res.status).toBe(200);
    expect(CategorySchema.parse(await bodyOf(res))).toMatchObject({
      id: created.id,
      name: 'After Rename',
      isActive: false,
    });
    const [row] = await db().select().from(gameCategory).where(eq(gameCategory.id, created.id));
    expect(row).toMatchObject({ name: 'After Rename', isActive: false });
    const audit = await auditRows('gaming.category.updated', created.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorType: 'admin',
      actorId: staff.userId,
      resourceType: 'game_category',
      before: expect.objectContaining({ name: 'Before Rename', isActive: true }),
      after: expect.objectContaining({ name: 'After Rename', isActive: false }),
    });
    const createdAudit = await auditRows('gaming.category.created', created.id);
    expect(createdAudit).toHaveLength(1);
  });

  it('a category rule previews the matching games without saving membership', async () => {
    const first = await newGame(e2e);
    const second = await newGame(e2e);
    const outsider = await newGame(e2e);
    const name = `preview-${randomUUID()}`;
    scriptMatches(name, [first.gameId, second.gameId]);
    const before = await db().select().from(gameCategory);

    const res = await e2e.admin.post('/backoffice/gaming/categories/rule-preview', {
      rule: scriptedRule(name),
      page: 1,
      limit: 20,
    });

    expect(res.status).toBe(200);
    const preview = PreviewSchema.parse(await bodyOf(res));
    expect(preview.total).toBe(2);
    expect(sorted(preview.items.map((item) => item.id))).toEqual(
      sorted([first.gameId, second.gameId]),
    );
    expect(await db().select().from(gameCategory)).toHaveLength(before.length);
    const links = await db()
      .select()
      .from(gameCategoryGame)
      .where(inArray(gameCategoryGame.gameId, [first.gameId, second.gameId, outsider.gameId]));
    expect(links).toEqual([]);
  });

  it('a rule that matches too many games is refused as too broad', async () => {
    const member = await newGame(e2e);
    const name = `broad-${randomUUID()}`;
    const category = await newRuleCategory(name, [member.gameId]);
    expect(await memberIdsOf(category.id)).toEqual([member.gameId]);
    scriptBroadMatch(name);

    const preview = await e2e.admin.post('/backoffice/gaming/categories/rule-preview', {
      rule: scriptedRule(name),
      page: 1,
      limit: 20,
    });
    const evaluate = await e2e.admin.post(
      `/backoffice/gaming/categories/${category.id}/membership/evaluate`,
    );

    expect(BROAD_MATCH_COUNT).toBeGreaterThan(5000);
    expect(preview.status).toBe(400);
    expect(ErrorSchema.parse(await bodyOf(preview)).code).toBe('BAD_REQUEST');
    expect(evaluate.status).toBe(400);
    expect(await memberIdsOf(category.id)).toEqual([member.gameId]);
  });

  it('evaluating membership adds newly matching games and removes games that no longer match', async () => {
    const stays = await newGame(e2e);
    const leaves = await newGame(e2e);
    const joins = await newGame(e2e);
    const name = `evaluate-${randomUUID()}`;
    const category = await newRuleCategory(name, [stays.gameId, leaves.gameId]);
    expect(sorted(await memberIdsOf(category.id))).toEqual(sorted([stays.gameId, leaves.gameId]));
    scriptMatches(name, [stays.gameId, joins.gameId]);

    const res = await e2e.admin.post(
      `/backoffice/gaming/categories/${category.id}/membership/evaluate`,
    );
    const again = await e2e.admin.post(
      `/backoffice/gaming/categories/${category.id}/membership/evaluate`,
    );

    expect(res.status).toBe(200);
    expect(EvaluationSchema.parse(await bodyOf(res))).toEqual({
      matchedCount: 2,
      addedCount: 1,
      removedCount: 1,
    });
    expect(sorted(await memberIdsOf(category.id))).toEqual(sorted([stays.gameId, joins.gameId]));
    expect(EvaluationSchema.parse(await bodyOf(again))).toEqual({
      matchedCount: 2,
      addedCount: 0,
      removedCount: 0,
    });
    const audit = await auditRows('gaming.category.membership_evaluated', category.id);
    expect(audit.length).toBeGreaterThanOrEqual(2);
  });

  it('a rule that cannot be resolved returns service unavailable and leaves membership unchanged', async () => {
    const first = await newGame(e2e);
    const second = await newGame(e2e);
    const name = `unavailable-${randomUUID()}`;
    const category = await newRuleCategory(name, [first.gameId, second.gameId]);
    scriptFailure(name);

    const evaluate = await e2e.admin.post(
      `/backoffice/gaming/categories/${category.id}/membership/evaluate`,
    );
    const preview = await e2e.admin.post('/backoffice/gaming/categories/rule-preview', {
      rule: scriptedRule(name),
      page: 1,
      limit: 20,
    });

    expect(evaluate.status).toBe(503);
    expect(ErrorSchema.parse(await bodyOf(evaluate)).code).toBe('SERVICE_UNAVAILABLE');
    expect(preview.status).toBe(503);
    expect(sorted(await memberIdsOf(category.id))).toEqual(sorted([first.gameId, second.gameId]));
    await vi.waitFor(async () => {
      const detail = await e2e.admin.get(`/backoffice/gaming/categories/${category.id}`);
      expect(CategorySchema.parse(await bodyOf(detail)).membershipLastError).not.toBeNull();
    });
  });

  it('a non-admin player calling any category write route is refused as forbidden', async () => {
    const intruder = await newPlayer(e2e.app, 'cat-intruder');
    const target = await newCategory({ name: 'Untouchable' });
    const slug = slugOf('intruder');
    const { gameId } = await newGame(e2e);

    const responses = [
      await createCategory(intruder.client, { slug }).then(({ res }) => res),
      await intruder.client.patch(`/backoffice/gaming/categories/${target.id}`, { name: 'Hacked' }),
      await intruder.client.post(`/backoffice/gaming/categories/${target.id}/membership/evaluate`),
      await intruder.client.put(`/backoffice/gaming/categories/${target.id}/games/order`, {
        gameIds: [gameId],
      }),
      await intruder.client.put(`/backoffice/gaming/categories/${target.id}/games/pins`, {
        pins: [{ gameId, position: 0 }],
      }),
      await intruder.client.post('/backoffice/gaming/games/bulk/categories', {
        gameIds: [gameId],
        categoryIds: [target.id],
      }),
    ];
    const anonymous = await e2e.app.app.request('/backoffice/gaming/categories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug, name: 'Anonymous' }),
    });

    for (const res of responses) {
      expect(res.status).toBe(403);
    }
    expect(anonymous.status).toBe(401);
    expect(await categoryRowsBySlug(slug)).toEqual([]);
    const [row] = await db().select().from(gameCategory).where(eq(gameCategory.id, target.id));
    expect(row?.name).toBe('Untouchable');
    expect(await memberIdsOf(target.id)).toEqual([]);
  });

  it('an admin without the rule reporting permission cannot save a rule category', async () => {
    const limited = await staffWithoutReporting();
    const manager = await newStaff(e2e.app, 'cat-reporter', 'casino-manager');
    const reportingRule = [{ key: 'most_played', params: { periodDays: 7, limit: 5 } }];
    const plain = await newCategory({ name: 'Plain Manual' });
    const refusedSlug = slugOf('reporting-refused');
    const allowedSlug = slugOf('reporting-allowed');

    const refusedCreate = await createCategory(limited.client, {
      slug: refusedSlug,
      membershipMode: 'rule',
      membershipRule: reportingRule,
    });
    const refusedUpdate = await limited.client.patch(`/backoffice/gaming/categories/${plain.id}`, {
      membershipMode: 'rule',
      membershipRule: reportingRule,
    });
    const refusedPreview = await limited.client.post('/backoffice/gaming/categories/rule-preview', {
      rule: reportingRule,
      page: 1,
      limit: 20,
    });
    const allowedCreate = await createCategory(manager.client, {
      slug: allowedSlug,
      membershipMode: 'rule',
      membershipRule: reportingRule,
    });

    expect(refusedCreate.res.status).toBe(403);
    expect(refusedUpdate.status).toBe(403);
    expect(refusedPreview.status).toBe(403);
    expect(await categoryRowsBySlug(refusedSlug)).toEqual([]);
    const [unchanged] = await db().select().from(gameCategory).where(eq(gameCategory.id, plain.id));
    expect(unchanged).toMatchObject({ membershipMode: 'manual', membershipRule: null });
    expect(allowedCreate.res.status).toBe(200);
    expect(await categoryRowsBySlug(allowedSlug)).toHaveLength(1);
  });
});

const PublicGamesSchema = z.object({ items: z.array(z.object({ id: z.string() })) });
const ReorderSchema = z.object({
  sortKey: z.string(),
  sortDirection: z.string().nullable(),
});

async function categoryWithGames(names: string[]) {
  const category = await newCategory({ name: 'Ordered' });
  const games = [];
  for (const name of names) {
    games.push(await newGame(e2e, { name }));
  }
  const res = await e2e.admin.post('/backoffice/gaming/games/bulk/categories', {
    gameIds: games.map((entry) => entry.gameId),
    categoryIds: [category.id],
  });
  expect(res.status).toBe(200);
  return { category, gameIds: games.map((entry) => entry.gameId) };
}

const publicOrderOf = async (categoryId: string) => {
  const res = await e2e.app.app.request(`/gaming/games?categoryId=${categoryId}&limit=50`);
  expect(res.status).toBe(200);
  return PublicGamesSchema.parse(await bodyOf(res)).items.map((item) => item.id);
};

const expectPublicOrder = (categoryId: string, expected: string[]) =>
  vi.waitFor(async () => expect(await publicOrderOf(categoryId)).toEqual(expected), {
    timeout: 10_000,
    interval: 100,
  });

const linkRows = async (categoryId: string) =>
  db().select().from(gameCategoryGame).where(eq(gameCategoryGame.categoryId, categoryId));

const reorder = (client: TestClient, categoryId: string, gameIds: string[]) =>
  client.put(`/backoffice/gaming/categories/${categoryId}/games/order`, { gameIds });

const pin = (
  client: TestClient,
  categoryId: string,
  pins: { gameId: string; position: number }[],
) => client.put(`/backoffice/gaming/categories/${categoryId}/games/pins`, { pins });

describe('admin orders games inside a category', () => {
  it('reordering category games stores the manual order and the public list returns it', async () => {
    const { category, gameIds } = await categoryWithGames(['Same', 'Same', 'Same']);
    const [first, second, third] = gameIds;
    const wanted = [third, first, second].filter((id): id is string => id !== undefined);

    const res = await reorder(e2e.admin, category.id, wanted);

    expect(res.status).toBe(200);
    expect(ReorderSchema.parse(await bodyOf(res))).toEqual({
      sortKey: 'manual',
      sortDirection: null,
    });
    const rows = await linkRows(category.id);
    expect(wanted.map((id) => rows.find((row) => row.gameId === id)?.position)).toEqual([0, 1, 2]);
    const [stored] = await db().select().from(gameCategory).where(eq(gameCategory.id, category.id));
    expect(stored?.sortKey).toBe('manual');
    await expectPublicOrder(category.id, wanted);
    const audit = await auditRows('gaming.category.games_reordered', category.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.after).toMatchObject({ gameIds: wanted, sortKey: 'manual' });
  });

  it('pinned games always rank above unpinned games regardless of the sort option', async () => {
    const { category, gameIds } = await categoryWithGames(['Alpha', 'Bravo', 'Charlie']);
    const [alpha, bravo, charlie] = gameIds;
    if (alpha === undefined || bravo === undefined || charlie === undefined) {
      throw new Error('games missing');
    }
    const sortBy = (sortDirection: 'asc' | 'desc') =>
      e2e.admin.patch(`/backoffice/gaming/categories/${category.id}`, {
        sortKey: 'name',
        sortDirection,
      });

    expect((await sortBy('asc')).status).toBe(200);
    await expectPublicOrder(category.id, [alpha, bravo, charlie]);
    expect((await pin(e2e.admin, category.id, [{ gameId: charlie, position: 0 }])).status).toBe(
      200,
    );
    await expectPublicOrder(category.id, [charlie, alpha, bravo]);

    expect((await sortBy('desc')).status).toBe(200);
    await expectPublicOrder(category.id, [charlie, bravo, alpha]);
    expect((await pin(e2e.admin, category.id, [{ gameId: alpha, position: 0 }])).status).toBe(200);
    await expectPublicOrder(category.id, [alpha, charlie, bravo]);

    expect((await reorder(e2e.admin, category.id, [bravo, charlie, alpha])).status).toBe(200);
    await expectPublicOrder(category.id, [alpha, bravo, charlie]);
    const pinned = (await linkRows(category.id)).filter((row) => row.pinnedPosition !== null);
    expect(pinned.map((row) => row.gameId)).toEqual([alpha]);
  });

  it('pinning a game that is not a member of the category is refused as bad request', async () => {
    const { category, gameIds } = await categoryWithGames(['Member']);
    const outsider = await newGame(e2e);
    const [member] = gameIds;

    const res = await pin(e2e.admin, category.id, [
      { gameId: member ?? '', position: 0 },
      { gameId: outsider.gameId, position: 1 },
    ]);
    const reorderRes = await reorder(e2e.admin, category.id, [outsider.gameId]);

    expect(res.status).toBe(400);
    expect(ErrorSchema.parse(await bodyOf(res)).code).toBe('BAD_REQUEST');
    expect(reorderRes.status).toBe(400);
    const rows = await linkRows(category.id);
    expect(rows.map((row) => row.gameId)).toEqual([member]);
    expect(rows[0]).toMatchObject({ pinnedPosition: null, position: null });
  });

  it('reordering a category that does not exist returns not found', async () => {
    const { gameId } = await newGame(e2e);
    const missing = randomUUID();

    const reorderRes = await reorder(e2e.admin, missing, [gameId]);
    const pinRes = await pin(e2e.admin, missing, [{ gameId, position: 0 }]);

    expect(reorderRes.status).toBe(404);
    expect(ErrorSchema.parse(await bodyOf(reorderRes)).code).toBe('NOT_FOUND');
    expect(pinRes.status).toBe(404);
    expect(
      await db().select().from(gameCategoryGame).where(eq(gameCategoryGame.gameId, gameId)),
    ).toEqual([]);
  });

  it('choosing a sort option with an invalid config is refused', async () => {
    const { category } = await categoryWithGames(['Alpha', 'Bravo']);
    const patch = (body: Record<string, unknown>) =>
      e2e.admin.patch(`/backoffice/gaming/categories/${category.id}`, body);

    const unknownKey = await patch({ sortKey: 'no_such_sort', sortDirection: 'asc' });
    const wrongDirection = await patch({ sortKey: 'manual', sortDirection: 'desc' });
    const oversizedParams = await patch({
      sortKey: 'name',
      sortDirection: 'asc',
      sortParams: { padding: 'x'.repeat(5000) },
    });

    for (const res of [unknownKey, wrongDirection, oversizedParams]) {
      expect(res.status).toBe(400);
      expect(ErrorSchema.parse(await bodyOf(res)).code).toBe('BAD_REQUEST');
    }
    const [stored] = await db().select().from(gameCategory).where(eq(gameCategory.id, category.id));
    expect(stored).toMatchObject({ sortKey: category.sortKey, sortDirection: null });
    const valid = await patch({ sortKey: 'name', sortDirection: 'desc' });
    expect(valid.status).toBe(200);
  });

  it('a repeated reorder with the same payload leaves the ranking unchanged', async () => {
    const { category, gameIds } = await categoryWithGames(['Same', 'Same', 'Same']);
    const wanted = [...gameIds].reverse();

    expect((await reorder(e2e.admin, category.id, wanted)).status).toBe(200);
    await expectPublicOrder(category.id, wanted);
    const snapshot = async () =>
      (await linkRows(category.id))
        .map(({ gameId, position, rank, pinnedPosition }) => ({
          gameId,
          position,
          rank,
          pinnedPosition,
        }))
        .sort((a, b) => a.gameId.localeCompare(b.gameId));
    const afterFirst = await snapshot();
    const repeated = await reorder(e2e.admin, category.id, wanted);

    expect(repeated.status).toBe(200);
    await expectPublicOrder(category.id, wanted);
    expect(await snapshot()).toEqual(afterFirst);
  });

  it('a non-admin calling reorder or pin is refused as forbidden', async () => {
    const intruder = await newPlayer(e2e.app, 'order-intruder');
    const { category, gameIds } = await categoryWithGames(['Alpha', 'Bravo']);
    const [alpha, bravo] = gameIds;
    if (alpha === undefined || bravo === undefined) {
      throw new Error('games missing');
    }

    const reorderRes = await reorder(intruder.client, category.id, [bravo, alpha]);
    const pinRes = await pin(intruder.client, category.id, [{ gameId: alpha, position: 0 }]);
    const anonymous = await e2e.app.app.request(
      `/backoffice/gaming/categories/${category.id}/games/order`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gameIds: [bravo, alpha] }),
      },
    );

    expect(reorderRes.status).toBe(403);
    expect(pinRes.status).toBe(403);
    expect(anonymous.status).toBe(401);
    const rows = await linkRows(category.id);
    for (const row of rows) {
      expect(row).toMatchObject({ position: null, pinnedPosition: null });
    }
    const [stored] = await db().select().from(gameCategory).where(eq(gameCategory.id, category.id));
    expect(stored?.sortKey).toBe(category.sortKey);
  });
});

const ProviderSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  isActive: z.boolean(),
});
const TagSchema = z.object({ id: z.string(), name: z.string(), visibility: z.string() });
const BulkSchema = z.object({
  games: z.object({ updatedCount: z.number(), unchangedCount: z.number() }),
});

const tagLinkRows = (tagId: string) =>
  db().select().from(gameTagGame).where(eq(gameTagGame.tagId, tagId));

const gameRow = async (gameId: string) => {
  const [row] = await db().select().from(game).where(eq(game.id, gameId));
  return row;
};

async function bulkAuditRowsOf(actorId: string) {
  await flushAudit(e2e.app);
  return db()
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, 'gaming.games.bulk_updated'), eq(auditLog.actorId, actorId)));
}

describe('admin manages providers, tags and bulk edits', () => {
  it('an admin creates and updates a provider and the change is audited', async () => {
    const staff = await newStaff(e2e.app, 'provider-editor', 'casino-manager');
    const slug = slugOf('provider');

    const created = await staff.client.post('/backoffice/gaming/providers', {
      slug,
      name: 'Studio One',
    });

    expect(created.status).toBe(200);
    const provider = ProviderSchema.parse(await bodyOf(created));
    expect(provider).toMatchObject({ slug, name: 'Studio One', isActive: false });
    const createdAudit = await auditRows('gaming.provider.created', provider.id);
    expect(createdAudit).toHaveLength(1);
    expect(createdAudit[0]).toMatchObject({
      actorType: 'admin',
      actorId: staff.userId,
      resourceType: 'game_provider',
      after: expect.objectContaining({ slug, name: 'Studio One' }),
    });

    const updated = await staff.client.patch(`/backoffice/gaming/providers/${provider.id}`, {
      name: 'Studio Two',
      isActive: true,
    });

    expect(updated.status).toBe(200);
    expect(ProviderSchema.parse(await bodyOf(updated))).toMatchObject({
      id: provider.id,
      name: 'Studio Two',
      isActive: true,
    });
    const [row] = await db().select().from(gameProvider).where(eq(gameProvider.id, provider.id));
    expect(row).toMatchObject({ name: 'Studio Two', isActive: true });
    const updatedAudit = await auditRows('gaming.provider.updated', provider.id);
    expect(updatedAudit).toHaveLength(1);
    expect(updatedAudit[0]).toMatchObject({
      actorId: staff.userId,
      before: expect.objectContaining({ name: 'Studio One', isActive: false }),
      after: expect.objectContaining({ name: 'Studio Two', isActive: true }),
    });
    const duplicate = await staff.client.post('/backoffice/gaming/providers', {
      slug,
      name: 'Impostor',
    });
    expect(duplicate.status).toBe(409);
  });

  it('a provider logo URL on a host that is not allowed is refused', async () => {
    const created = await e2e.admin.post('/backoffice/gaming/providers', {
      slug: slugOf('logo-provider'),
      name: 'Logo Studio',
    });
    const provider = ProviderSchema.parse(await bodyOf(created));

    const foreign = await e2e.admin.patch(`/backoffice/gaming/providers/${provider.id}`, {
      customLogoUrl: 'https://evil.example.net/logo.png',
    });
    const plainHttp = await e2e.admin.patch(`/backoffice/gaming/providers/${provider.id}`, {
      customLogoUrl: 'http://evil.example.net/logo.png',
    });
    const credentials = await e2e.admin.patch(`/backoffice/gaming/providers/${provider.id}`, {
      customLogoUrl: 'https://user:secret@evil.example.net/logo.png',
    });

    expect(foreign.status).toBe(400);
    expect(ErrorSchema.parse(await bodyOf(foreign)).code).toBe('BAD_REQUEST');
    expect(plainHttp.status).toBe(400);
    expect(credentials.status).toBe(400);
    const [row] = await db().select().from(gameProvider).where(eq(gameProvider.id, provider.id));
    expect(row?.customLogoUrl).toBeNull();
    await flushAudit(e2e.app);
    const audit = await db()
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, 'gaming.provider.updated'), eq(auditLog.resourceId, provider.id)),
      );
    expect(audit).toEqual([]);
  });

  it('an admin creates a tag and assigns it to games in bulk', async () => {
    const staff = await newStaff(e2e.app, 'tag-editor', 'casino-manager');
    const tagged = await newGame(e2e);
    const alsoTagged = await newGame(e2e);
    const untouched = await newGame(e2e);
    const name = `tag-${randomUUID()}`;

    const created = await staff.client.post('/backoffice/gaming/tags', {
      name,
      visibility: 'visible',
    });

    expect(created.status).toBe(200);
    const tag = TagSchema.parse(await bodyOf(created));
    expect(tag).toMatchObject({ name, visibility: 'visible' });
    const tagAudit = await auditRows('gaming.tag.created', tag.id);
    expect(tagAudit[0]).toMatchObject({ actorId: staff.userId, resourceType: 'game_tag' });

    const assigned = await staff.client.post('/backoffice/gaming/games/bulk/tags', {
      gameIds: [tagged.gameId, alsoTagged.gameId],
      tagIds: [tag.id],
    });
    const repeated = await staff.client.post('/backoffice/gaming/games/bulk/tags', {
      gameIds: [tagged.gameId, alsoTagged.gameId],
      tagIds: [tag.id],
    });

    expect(assigned.status).toBe(200);
    expect(BulkSchema.parse(await bodyOf(assigned)).games).toEqual({
      updatedCount: 2,
      unchangedCount: 0,
    });
    expect(BulkSchema.parse(await bodyOf(repeated)).games).toEqual({
      updatedCount: 0,
      unchangedCount: 2,
    });
    const links = await tagLinkRows(tag.id);
    expect(sorted(links.map((link) => link.gameId))).toEqual(
      sorted([tagged.gameId, alsoTagged.gameId]),
    );
    expect(links.some((link) => link.gameId === untouched.gameId)).toBe(false);
    const missing = await staff.client.post('/backoffice/gaming/games/bulk/tags', {
      gameIds: [untouched.gameId],
      tagIds: [randomUUID()],
    });
    expect(missing.status).toBe(404);
    expect(
      await db().select().from(gameTagGame).where(eq(gameTagGame.gameId, untouched.gameId)),
    ).toEqual([]);
  });

  it('a bulk edit on games writes one audit row and leaves unrelated games untouched', async () => {
    const staff = await newStaff(e2e.app, 'bulk-editor', 'casino-manager');
    const first = await newGame(e2e);
    const second = await newGame(e2e);
    const third = await newGame(e2e);
    const bystander = await newGame(e2e);

    const res = await staff.client.post('/backoffice/gaming/games/bulk/active', {
      gameIds: [first.gameId, second.gameId, third.gameId],
      isActive: false,
    });

    expect(res.status).toBe(200);
    expect(BulkSchema.parse(await bodyOf(res)).games).toEqual({
      updatedCount: 3,
      unchangedCount: 0,
    });
    for (const target of [first, second, third]) {
      expect((await gameRow(target.gameId))?.isActive).toBe(false);
    }
    expect((await gameRow(bystander.gameId))?.isActive).toBe(true);
    const [bystanderProvider] = await db()
      .select()
      .from(gameProvider)
      .where(eq(gameProvider.id, bystander.providerId));
    expect(bystanderProvider?.isActive).toBe(true);
    await vi.waitFor(async () => expect(await bulkAuditRowsOf(staff.userId)).toHaveLength(1), {
      timeout: 10_000,
      interval: 100,
    });
    const [audit] = await bulkAuditRowsOf(staff.userId);
    expect(audit).toMatchObject({
      actorType: 'admin',
      resourceType: 'game',
      after: expect.objectContaining({ operation: 'set_active', isActive: false }),
      before: expect.objectContaining({ isActive: true }),
    });
    const noop = await staff.client.post('/backoffice/gaming/games/bulk/active', {
      gameIds: [first.gameId, second.gameId, third.gameId],
      isActive: false,
    });
    expect(BulkSchema.parse(await bodyOf(noop)).games).toEqual({
      updatedCount: 0,
      unchangedCount: 3,
    });
    expect(await bulkAuditRowsOf(staff.userId)).toHaveLength(1);
  });

  it('a non-admin calling any provider, tag or bulk route is refused as forbidden', async () => {
    const intruder = await newPlayer(e2e.app, 'catalog-intruder');
    const provider = ProviderSchema.parse(
      await bodyOf(
        await e2e.admin.post('/backoffice/gaming/providers', {
          slug: slugOf('guarded-provider'),
          name: 'Guarded',
        }),
      ),
    );
    const tag = TagSchema.parse(
      await bodyOf(
        await e2e.admin.post('/backoffice/gaming/tags', {
          name: `guarded-${randomUUID()}`,
          visibility: 'visible',
        }),
      ),
    );
    const target = await newGame(e2e);
    const newSlug = slugOf('intruder-provider');
    const newTagName = `intruder-${randomUUID()}`;

    const responses = [
      await intruder.client.post('/backoffice/gaming/providers', { slug: newSlug, name: 'Nope' }),
      await intruder.client.patch(`/backoffice/gaming/providers/${provider.id}`, {
        name: 'Hacked',
        isActive: true,
      }),
      await intruder.client.post('/backoffice/gaming/tags', { name: newTagName }),
      await intruder.client.patch(`/backoffice/gaming/tags/${tag.id}`, { name: 'Hacked' }),
      await intruder.client.del(`/backoffice/gaming/tags/${tag.id}`),
      await intruder.client.post('/backoffice/gaming/games/bulk/tags', {
        gameIds: [target.gameId],
        tagIds: [tag.id],
      }),
      await intruder.client.post('/backoffice/gaming/games/bulk/active', {
        gameIds: [target.gameId],
        isActive: false,
      }),
      await intruder.client.post('/backoffice/gaming/games/bulk/review', {
        gameIds: [target.gameId],
        decision: 'decline',
      }),
    ];
    const anonymous = await e2e.app.app.request('/backoffice/gaming/games/bulk/active', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gameIds: [target.gameId], isActive: false }),
    });

    for (const res of responses) {
      expect(res.status).toBe(403);
    }
    expect(anonymous.status).toBe(401);
    expect(await db().select().from(gameProvider).where(eq(gameProvider.slug, newSlug))).toEqual(
      [],
    );
    expect(await db().select().from(gameTag).where(eq(gameTag.name, newTagName))).toEqual([]);
    const [providerRow] = await db()
      .select()
      .from(gameProvider)
      .where(eq(gameProvider.id, provider.id));
    expect(providerRow).toMatchObject({ name: 'Guarded', isActive: false });
    const [tagRow] = await db().select().from(gameTag).where(eq(gameTag.id, tag.id));
    expect(tagRow?.name).toBe(tag.name);
    expect(await tagLinkRows(tag.id)).toEqual([]);
    expect(await gameRow(target.gameId)).toMatchObject({
      isActive: true,
      reviewStatus: 'approved',
    });
  });
});

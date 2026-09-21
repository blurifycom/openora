import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadExtensions, DRIZZLE } from '@openora/core/server';
import { GAMING_COMMANDS, JOB_QUEUE, queue } from '@openora/core/contracts';
import { game, gameProvider, gameRound } from '@openora/core/casino/schema/gaming';
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

const providers = (...providerIds: string[]) => ({ key: 'providers', params: { providerIds } });
const tags = (...tagIds: string[]) => ({ key: 'tags', params: { tagIds } });

let db: TestDb;
let app: TestApp;
let admin: TestClient;
let player: TestClient;

// oxlint-disable-next-line typescript/no-explicit-any -- ad-hoc JSON shape assertions in tests
async function readJson(res: Response): Promise<any> {
  return res.json();
}

function drizzle() {
  return app.container.get(DRIZZLE).db;
}

async function seedProvider() {
  const [row] = await drizzle()
    .insert(gameProvider)
    .values({
      slug: `e2e-rule-provider-${randomUUID()}`,
      name: 'E2E Rule Provider',
      isActive: true,
    })
    .returning();
  if (!row) {
    throw new Error('failed to seed a game provider');
  }
  return row;
}

async function seedGame(providerId: string, overrides: Partial<typeof game.$inferInsert> = {}) {
  const [row] = await drizzle()
    .insert(game)
    .values({
      name: 'E2E Rule Game',
      slug: `e2e-rule-game-${randomUUID()}`,
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

async function createTag() {
  const res = await admin.post('/backoffice/gaming/tags', { name: `e2e-rule-tag-${randomUUID()}` });
  expect(res.status).toBe(200);
  return readJson(res);
}

async function createCategory(body: Record<string, unknown> = {}) {
  const res = await admin.post('/backoffice/gaming/categories', {
    slug: `e2e-rule-cat-${randomUUID()}`,
    name: 'E2E Rule Category',
    ...body,
  });
  expect(res.status).toBe(200);
  return readJson(res);
}

async function categoryGameIds(categoryId: string): Promise<string[]> {
  const res = await admin.get(`/backoffice/gaming/categories/${categoryId}/games?page=1&limit=100`);
  expect(res.status).toBe(200);
  const items = (await readJson(res)).items as Array<{ id: string }>;
  return items.map((item) => item.id).sort();
}

async function waitForCategoryGames(categoryId: string, expectedIds: string[]) {
  await vi.waitFor(async () => {
    expect(await categoryGameIds(categoryId)).toEqual([...expectedIds].sort());
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

describe('rule-based category membership e2e', () => {
  it('creates a rule category populated at once, visible through the public games list', async () => {
    const provider = await seedProvider();
    const member = await seedGame(provider.id);
    await seedGame((await seedProvider()).id);

    const category = await createCategory({
      membershipMode: 'rule',
      membershipRule: [providers(provider.id)],
    });

    expect(category).toMatchObject({
      membershipMode: 'rule',
      membershipRule: [providers(provider.id)],
    });
    expect(category.membershipEvaluatedAt).not.toBeNull();
    const res = await app.app.request(`/gaming/games?categoryId=${category.id}&page=1&limit=100`);
    expect(res.status).toBe(200);
    expect((await readJson(res)).items.map((g: { id: string }) => g.id)).toEqual([member.id]);
  });

  it('switches a manual category to a rule and back, keeping the games on the way back', async () => {
    const [listed, other] = [await seedProvider(), await seedProvider()];
    const matched = await seedGame(listed.id);
    const handPicked = await seedGame(other.id);
    const category = await createCategory();
    const assign = await admin.patch(`/backoffice/gaming/games/${handPicked.id}`, {
      id: handPicked.id,
      categoryIds: [category.id],
    });
    expect(assign.status).toBe(200);

    const toRule = await admin.patch(`/backoffice/gaming/categories/${category.id}`, {
      id: category.id,
      membershipMode: 'rule',
      membershipRule: [providers(listed.id)],
    });
    expect(toRule.status).toBe(200);
    expect(await categoryGameIds(category.id)).toEqual([matched.id]);

    const toManual = await admin.patch(`/backoffice/gaming/categories/${category.id}`, {
      id: category.id,
      membershipMode: 'manual',
    });
    expect(toManual.status).toBe(200);
    expect(await categoryGameIds(category.id)).toEqual([matched.id]);
    const remove = await admin.patch(`/backoffice/gaming/games/${matched.id}`, {
      id: matched.id,
      categoryIds: [],
    });
    expect(remove.status).toBe(200);
    expect(await categoryGameIds(category.id)).toEqual([]);
  });

  it('rejects rule mode without a rule, an unknown tag, an unknown rule key and an empty rule (400)', async () => {
    const base = { slug: `e2e-rule-cat-${randomUUID()}`, name: 'E2E Rule Category' };

    const noRule = await admin.post('/backoffice/gaming/categories', {
      ...base,
      membershipMode: 'rule',
    });
    expect(noRule.status).toBe(400);

    const unknownTag = await admin.post('/backoffice/gaming/categories', {
      ...base,
      membershipMode: 'rule',
      membershipRule: [tags(randomUUID())],
    });
    expect(unknownTag.status).toBe(400);

    const unknownKey = await admin.post('/backoffice/gaming/categories', {
      ...base,
      membershipMode: 'rule',
      membershipRule: [{ key: 'no_such_kind', params: {} }],
    });
    expect(unknownKey.status).toBe(400);

    const emptyRule = await admin.post('/backoffice/gaming/categories', {
      ...base,
      membershipMode: 'rule',
      membershipRule: [],
    });
    expect(emptyRule.status).toBe(400);
  });

  it('guards manual writes: a game update or bulk add touching a rule category is a 409', async () => {
    const provider = await seedProvider();
    const member = await seedGame(provider.id);
    const outsider = await seedGame((await seedProvider()).id);
    const ruleCategory = await createCategory({
      membershipMode: 'rule',
      membershipRule: [providers(provider.id)],
    });
    const manualCategory = await createCategory();

    const add = await admin.patch(`/backoffice/gaming/games/${outsider.id}`, {
      id: outsider.id,
      categoryIds: [ruleCategory.id],
    });
    expect(add.status).toBe(409);

    const remove = await admin.patch(`/backoffice/gaming/games/${member.id}`, {
      id: member.id,
      categoryIds: [],
    });
    expect(remove.status).toBe(409);

    const bulk = await admin.post('/backoffice/gaming/games/bulk/categories', {
      gameIds: [outsider.id],
      categoryIds: [manualCategory.id, ruleCategory.id],
    });
    expect(bulk.status).toBe(409);
    expect(await categoryGameIds(ruleCategory.id)).toEqual([member.id]);
    expect(await categoryGameIds(manualCategory.id)).toEqual([]);

    // Re-sending the rule category a game is already in, next to a manual one, is fine -
    // and leaves the kept link's row, pin included, alone.
    const pin = await admin.put(`/backoffice/gaming/categories/${ruleCategory.id}/games/pins`, {
      id: ruleCategory.id,
      pins: [{ gameId: member.id, position: 0 }],
    });
    expect(pin.status).toBe(200);
    const keep = await admin.patch(`/backoffice/gaming/games/${member.id}`, {
      id: member.id,
      categoryIds: [ruleCategory.id, manualCategory.id],
    });
    expect(keep.status).toBe(200);
    expect(await categoryGameIds(ruleCategory.id)).toEqual([member.id]);
    expect(await categoryGameIds(manualCategory.id)).toEqual([member.id]);
    const listed = await admin.get(
      `/backoffice/gaming/categories/${ruleCategory.id}/games?page=1&limit=100`,
    );
    expect((await readJson(listed)).items).toEqual([
      expect.objectContaining({ id: member.id, pinnedPosition: 0 }),
    ]);
  });

  it('previews an unsaved rule with a count and a first page, writing nothing', async () => {
    const provider = await seedProvider();
    const alpha = await seedGame(provider.id, { name: 'Alpha' });
    const bravo = await seedGame(provider.id, { name: 'Bravo' });

    const res = await admin.post('/backoffice/gaming/categories/rule-preview', {
      rule: [providers(provider.id)],
      page: 1,
      limit: 1,
    });

    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body).toMatchObject({ total: 2, page: 1, limit: 1 });
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ id: alpha.id, provider: { id: provider.id } });
    expect(body.items[0].id).not.toBe(bravo.id);
  });

  it('lists the bound rule kinds with a JSON Schema for each, for a rule-builder UI', async () => {
    const res = await admin.get('/backoffice/gaming/category-rule-options');

    expect(res.status).toBe(200);
    const options = (await readJson(res)) as Array<{ key: string; exposesReporting: boolean }>;
    expect(options.map((option) => option.key)).toEqual(['providers', 'tags', 'most_played']);
    expect(options.find((option) => option.key === 'most_played')).toMatchObject({
      exposesReporting: false,
      paramsJsonSchema: { type: 'object', required: ['periodDays', 'limit'] },
    });
    expect((await player.get('/backoffice/gaming/category-rule-options')).status).toBe(403);
  });

  it('re-evaluates on demand: picks up a game inserted with no event at all', async () => {
    const provider = await seedProvider();
    const category = await createCategory({
      membershipMode: 'rule',
      membershipRule: [providers(provider.id)],
    });
    const late = await seedGame(provider.id);

    const res = await admin.post(
      `/backoffice/gaming/categories/${category.id}/membership/evaluate`,
      { id: category.id },
    );

    expect(res.status).toBe(200);
    expect(await readJson(res)).toMatchObject({ matchedCount: 1, addedCount: 1, removedCount: 0 });
    expect(await categoryGameIds(category.id)).toEqual([late.id]);

    const manual = await createCategory();
    const onManual = await admin.post(
      `/backoffice/gaming/categories/${manual.id}/membership/evaluate`,
      { id: manual.id },
    );
    expect(onManual.status).toBe(409);
  });

  it('denies the rule routes to a player (403) and to an anonymous caller (401)', async () => {
    const provider = await seedProvider();
    const category = await createCategory({
      membershipMode: 'rule',
      membershipRule: [providers(provider.id)],
    });
    const evaluatePath = `/backoffice/gaming/categories/${category.id}/membership/evaluate`;
    const previewBody = { rule: [providers(provider.id)] };

    expect((await player.post(evaluatePath, { id: category.id })).status).toBe(403);
    expect(
      (await player.post('/backoffice/gaming/categories/rule-preview', previewBody)).status,
    ).toBe(403);
    const anonymous = await app.app.request(evaluatePath, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: category.id }),
    });
    expect(anonymous.status).toBe(401);
  });

  it('event-driven: tagging a game moves it into the tag rule category, untagging moves it out', async () => {
    const provider = await seedProvider();
    const target = await seedGame(provider.id);
    const tag = await createTag();
    const category = await createCategory({
      membershipMode: 'rule',
      membershipRule: [tags(tag.id)],
    });
    expect(await categoryGameIds(category.id)).toEqual([]);

    const tagged = await admin.patch(`/backoffice/gaming/games/${target.id}`, {
      id: target.id,
      tagIds: [tag.id],
    });
    expect(tagged.status).toBe(200);
    await waitForCategoryGames(category.id, [target.id]);

    const untagged = await admin.patch(`/backoffice/gaming/games/${target.id}`, {
      id: target.id,
      tagIds: [],
    });
    expect(untagged.status).toBe(200);
    await waitForCategoryGames(category.id, []);
  });

  it('event-driven: a bulk tag add and a tag delete both re-evaluate the tag rule category', async () => {
    const provider = await seedProvider();
    const [first, second] = [await seedGame(provider.id), await seedGame(provider.id)];
    const tag = await createTag();
    const category = await createCategory({
      membershipMode: 'rule',
      membershipRule: [tags(tag.id)],
    });

    const bulk = await admin.post('/backoffice/gaming/games/bulk/tags', {
      gameIds: [first.id, second.id],
      tagIds: [tag.id],
    });
    expect(bulk.status).toBe(200);
    await waitForCategoryGames(category.id, [first.id, second.id]);

    const deleted = await admin.del(`/backoffice/gaming/tags/${tag.id}`);
    expect(deleted.status).toBe(200);
    await waitForCategoryGames(category.id, []);
  });

  it('event-driven: a catalogue import reporting its new games fills the provider rule category', async () => {
    const provider = await seedProvider();
    const category = await createCategory({
      membershipMode: 'rule',
      membershipRule: [providers(provider.id)],
    });
    const imported = await seedGame(provider.id);

    await app.container.get(GAMING_COMMANDS).notifyGamesCreated?.({ gameIds: [imported.id] });

    await waitForCategoryGames(category.id, [imported.id]);
  });

  it('scheduled: the membership sweep refreshes a most-played category as rounds come in', async () => {
    const provider = await seedProvider();
    const [quiet, busy] = [await seedGame(provider.id), await seedGame(provider.id)];
    const seedRounds = (gameId: string, count: number) =>
      drizzle()
        .insert(gameRound)
        .values(
          Array.from({ length: count }, () => ({
            gameId,
            userId: randomUUID(),
            status: 'completed' as const,
            betAmount: '10',
            winAmount: '0',
            currency: 'USD',
          })),
        );
    await seedRounds(quiet.id, 1);
    const category = await createCategory({
      membershipMode: 'rule',
      membershipRule: [
        providers(provider.id),
        { key: 'most_played', params: { periodDays: 7, limit: 1 } },
      ],
    });
    expect(await categoryGameIds(category.id)).toEqual([quiet.id]);

    await seedRounds(busy.id, 5);
    await app.container.get(JOB_QUEUE).enqueue(queue('gaming.category.membership-sweep'), {});

    await waitForCategoryGames(category.id, [busy.id]);
  });
});

describe('an operator-supplied rule kind, rebound via GAME_CATEGORY_RULE_CATALOG e2e', () => {
  let customApp: TestApp;
  let customAdmin: TestClient;

  beforeAll(async () => {
    customApp = await bootTestApp({
      plugins: [
        ...(await loadExtensions()),
        {
          id: 'test-custom-category-rule',
          path: fileURLToPath(new URL('../test-custom-category-rule-plugin.ts', import.meta.url)),
        },
      ],
      databaseUrl: db.url,
    });
    await seedMinimal(customApp.container, { playerCount: 0 });
    customAdmin = await asAdmin(customApp.app);
  }, 60_000);

  afterAll(async () => {
    await customApp?.close();
  });

  it('is offered, validated and resolved end to end, narrowing a built-in clause', async () => {
    const provider = await seedProvider();
    const original = await seedGame(provider.id, { gameType: 'original' });
    await seedGame(provider.id, { gameType: 'casino' });
    await seedGame((await seedProvider()).id, { gameType: 'original' });

    const options = await readJson(
      await customAdmin.get('/backoffice/gaming/category-rule-options'),
    );
    expect(options.map((option: { key: string }) => option.key)).toContain('test_game_type');

    const badParams = await customAdmin.post('/backoffice/gaming/categories', {
      slug: `e2e-custom-rule-${randomUUID()}`,
      name: 'Custom Rule Category',
      membershipMode: 'rule',
      membershipRule: [{ key: 'test_game_type', params: { gameType: 'bingo' } }],
    });
    expect(badParams.status).toBe(400);

    const created = await customAdmin.post('/backoffice/gaming/categories', {
      slug: `e2e-custom-rule-${randomUUID()}`,
      name: 'Custom Rule Category',
      membershipMode: 'rule',
      membershipRule: [
        providers(provider.id),
        { key: 'test_game_type', params: { gameType: 'original' } },
      ],
    });
    expect(created.status).toBe(200);
    const category = await readJson(created);
    const listed = await customAdmin.get(
      `/backoffice/gaming/categories/${category.id}/games?page=1&limit=100`,
    );
    expect((await readJson(listed)).items.map((g: { id: string }) => g.id)).toEqual([original.id]);

    // The default app has no such kind: it refuses to evaluate the category and leaves
    // its games alone rather than emptying it.
    const evaluated = await admin.post(
      `/backoffice/gaming/categories/${category.id}/membership/evaluate`,
      { id: category.id },
    );
    expect(evaluated.status).toBe(400);
    expect(await categoryGameIds(category.id)).toEqual([original.id]);
  });
});

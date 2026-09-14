import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  loadExtensions,
  DRIZZLE,
  type Container,
  type CoreTokenCatalog,
} from '@openora/core/server';
import { game, gameProvider, gameTag } from '@openora/core/casino/schema/gaming';
import {
  setupTestDb,
  bootTestApp,
  asAdmin,
  seedMinimal,
  type TestDb,
  type TestApp,
  type TestClient,
} from '../index.js';

let db: TestDb;
let app: TestApp;
let admin: TestClient;
let gameId: string;

// oxlint-disable-next-line typescript/no-explicit-any -- ad-hoc JSON shape assertions in tests
async function readJson(res: Response): Promise<any> {
  return res.json();
}

function drizzleOf(container: Container<CoreTokenCatalog>) {
  return container.get(DRIZZLE).db;
}

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['WITHDRAWAL_PIN_HMAC_SECRET'] ??= 'e2e-test-withdrawal-pin-hmac-secret-000000';
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  app = await bootTestApp({ plugins: await loadExtensions(), databaseUrl: db.url });
  await seedMinimal(app.container, { playerCount: 0 });
  admin = await asAdmin(app.app);

  const [provider] = await drizzleOf(app.container)
    .insert(gameProvider)
    .values({
      slug: `e2e-tags-provider-${randomUUID()}`,
      name: 'E2E Tags Provider',
      isActive: true,
    })
    .returning();
  const [created] = await drizzleOf(app.container)
    .insert(game)
    .values({
      name: 'E2E Tagged Game',
      slug: `e2e-tagged-game-${randomUUID()}`,
      providerId: provider!.id,
      aggregator: 'direct',
      isActive: true,
    })
    .returning();
  if (!created) {
    throw new Error('failed to seed the tagged game');
  }
  gameId = created.id;
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.dispose();
});

describe('gaming game tags e2e', () => {
  it('supports admin CRUD, assignment, public visibility filtering, and system deletion refusal', async () => {
    const invisibleResponse = await admin.post('/backoffice/gaming/tags', {
      name: `E2E Invisible ${randomUUID()}`,
    });
    expect(invisibleResponse.status).toBe(200);
    const invisible = await readJson(invisibleResponse);
    expect(invisible).toMatchObject({
      type: 'custom',
      visibility: 'invisible',
      badgeSettings: { badgeColor: '#3377ff', textColor: '#ffffff' },
    });

    const visibleResponse = await admin.post('/backoffice/gaming/tags', {
      name: `E2E Visible ${randomUUID()}`,
      visibility: 'visible',
      badgeSettings: { badgeColor: '#112233', textColor: '#abcdef' },
    });
    expect(visibleResponse.status).toBe(200);
    const visible = await readJson(visibleResponse);

    const listResponse = await admin.get('/backoffice/gaming/tags?page=1&limit=50&type=custom');
    expect(listResponse.status).toBe(200);
    const list = await readJson(listResponse);
    expect(list.items.map((tag: { id: string }) => tag.id)).toEqual(
      expect.arrayContaining([invisible.id, visible.id]),
    );

    const updateResponse = await admin.patch(`/backoffice/gaming/tags/${invisible.id}`, {
      name: `${invisible.name} Updated`,
    });
    expect(updateResponse.status).toBe(200);
    expect(await readJson(updateResponse)).toMatchObject({
      name: `${invisible.name} Updated`,
      visibility: 'invisible',
    });

    const assignmentResponse = await admin.patch(`/backoffice/gaming/games/${gameId}`, {
      tagIds: [invisible.id, visible.id],
    });
    expect(assignmentResponse.status).toBe(200);
    expect((await readJson(assignmentResponse)).tags).toHaveLength(2);

    const publicResponse = await app.app.request(`/gaming/games/${gameId}`);
    expect(publicResponse.status).toBe(200);
    expect((await readJson(publicResponse)).tags).toMatchObject([
      { id: visible.id, visibility: 'visible' },
    ]);

    const [system] = await drizzleOf(app.container)
      .insert(gameTag)
      .values({ name: `E2E System ${randomUUID()}`, type: 'system' })
      .returning();
    if (!system) {
      throw new Error('failed to seed a system tag');
    }
    const deleteSystemResponse = await admin.del(`/backoffice/gaming/tags/${system.id}`);
    expect(deleteSystemResponse.status).toBe(409);
    expect((await admin.get(`/backoffice/gaming/tags/${system.id}`)).status).toBe(200);

    const deleteCustomResponse = await admin.del(`/backoffice/gaming/tags/${invisible.id}`);
    expect(deleteCustomResponse.status).toBe(200);
    const deleteVisibleResponse = await admin.del(`/backoffice/gaming/tags/${visible.id}`);
    expect(deleteVisibleResponse.status).toBe(200);

    const [remainingSystem] = await drizzleOf(app.container)
      .select({ id: gameTag.id })
      .from(gameTag)
      .where(eq(gameTag.id, system.id));
    expect(remainingSystem?.id).toBe(system.id);
  });
});

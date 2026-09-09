import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { DRIZZLE, loadExtensions } from '@openora/core/server';
import { gameCategory } from '@openora/core/casino/schema/gaming';
import {
  asAdmin,
  bootTestApp,
  seedMinimal,
  setupTestDb,
  type TestApp,
  type TestClient,
  type TestDb,
} from '../index.js';

let db: TestDb;
let testApp: TestApp;
let admin: TestClient;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error('expected JSON object');
  }
  return value;
}

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['WITHDRAWAL_PIN_HMAC_SECRET'] ??= 'e2e-test-withdrawal-pin-hmac-secret-000000';
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  testApp = await bootTestApp({ plugins: await loadExtensions(), databaseUrl: db.url });
  await seedMinimal(testApp.container, { playerCount: 0 });
  admin = await asAdmin(testApp.app);
}, 60_000);

afterAll(async () => {
  await testApp?.close();
  await db?.dispose();
});

describe('gaming category translations API', () => {
  it('round-trips replacement, omitted, and clear updates through gaming outputs', async () => {
    const slug = `translations-${randomUUID()}`;
    const create = await admin.post('/backoffice/gaming/categories', {
      slug,
      name: 'Table Games',
      translations: { DE: { name: 'Tischspiele' } },
    });
    expect(create.status).toBe(200);
    const created = object(await create.json());
    const categoryId = created['id'];
    if (typeof categoryId !== 'string') {
      throw new Error('category response has no id');
    }
    expect(created['translations']).toEqual({ DE: { name: 'Tischspiele' } });

    const adminDetail = await admin.get(`/backoffice/gaming/categories/${categoryId}`);
    expect(adminDetail.status).toBe(200);
    expect(object(await adminDetail.json())['translations']).toEqual({
      DE: { name: 'Tischspiele' },
    });

    const replacement = await admin.patch(`/backoffice/gaming/categories/${categoryId}`, {
      id: categoryId,
      translations: { FR: { name: 'Jeux de table' } },
    });
    expect(replacement.status).toBe(200);
    expect(object(await replacement.json())['translations']).toEqual({
      FR: { name: 'Jeux de table' },
    });

    const omitted = await admin.patch(`/backoffice/gaming/categories/${categoryId}`, {
      id: categoryId,
      name: 'Casino Table Games',
    });
    expect(omitted.status).toBe(200);
    expect(object(await omitted.json())['translations']).toEqual({
      FR: { name: 'Jeux de table' },
    });

    const [categoryRow] = await testApp.container
      .get(DRIZZLE)
      .db.select()
      .from(gameCategory)
      .where(eq(gameCategory.id, categoryId));
    expect(categoryRow?.translations).toEqual({ FR: { name: 'Jeux de table' } });

    const gaming = await admin.get('/gaming/categories');
    expect(gaming.status).toBe(200);
    expect(await gaming.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: categoryId,
          translations: { FR: { name: 'Jeux de table' } },
        }),
      ]),
    );

    const adminList = await admin.get('/backoffice/gaming/categories?page=1&limit=50');
    expect(adminList.status).toBe(200);
    expect(await adminList.json()).toEqual(
      expect.objectContaining({
        items: expect.arrayContaining([
          expect.objectContaining({
            id: categoryId,
            translations: { FR: { name: 'Jeux de table' } },
          }),
        ]),
      }),
    );

    const cleared = await admin.patch(`/backoffice/gaming/categories/${categoryId}`, {
      id: categoryId,
      translations: {},
    });
    expect(cleared.status).toBe(200);
    expect(object(await cleared.json())['translations']).toEqual({});
    const [clearedRow] = await testApp.container
      .get(DRIZZLE)
      .db.select({ translations: gameCategory.translations })
      .from(gameCategory)
      .where(eq(gameCategory.id, categoryId));
    expect(clearedRow?.translations).toEqual({});
  });

  it('rejects an unauthenticated category mutation', async () => {
    const response = await testApp.app.request('/backoffice/gaming/categories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: `unauthorized-${randomUUID()}`, name: 'Unauthorized' }),
    });

    expect([401, 403]).toContain(response.status);
  });
});

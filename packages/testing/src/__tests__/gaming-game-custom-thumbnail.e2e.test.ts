import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { and, asc, eq } from 'drizzle-orm';
import {
  loadExtensions,
  DRIZZLE,
  type Container,
  type CoreTokenCatalog,
} from '@openora/core/server';
import { auditLog } from '@openora/core/audit/schema';
import { game, gameProvider } from '@openora/core/casino/schema/gaming';
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

async function seedProvider() {
  const [row] = await drizzleOf(app.container)
    .insert(gameProvider)
    .values({
      slug: `e2e-custom-thumb-provider-${randomUUID()}`,
      name: 'E2E Custom Thumbnail Provider',
      isActive: true,
    })
    .returning();
  if (!row) {
    throw new Error('failed to seed a game provider');
  }
  return row;
}

async function seedGame(providerId: string) {
  const [row] = await drizzleOf(app.container)
    .insert(game)
    .values({
      name: 'E2E Custom Thumbnail Game',
      slug: `e2e-custom-thumb-game-${randomUUID()}`,
      providerId,
      aggregator: 'direct',
      isActive: true,
      thumbnailUrl: 'https://cdn.example/aggregator.png',
    })
    .returning();
  if (!row) {
    throw new Error('failed to seed a game');
  }
  return row;
}

async function gameUpdatedAuditRows(gameId: string) {
  return drizzleOf(app.container)
    .select({ before: auditLog.before, after: auditLog.after })
    .from(auditLog)
    .where(and(eq(auditLog.action, 'gaming.game.updated'), eq(auditLog.resourceId, gameId)))
    .orderBy(asc(auditLog.seq));
}

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['WITHDRAWAL_PIN_HMAC_SECRET'] ??= 'e2e-test-withdrawal-pin-hmac-secret-000000';
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  app = await bootTestApp({
    plugins: [
      ...(await loadExtensions()),
      {
        id: 'testing-gaming-thumbnail-config',
        path: fileURLToPath(
          new URL('./fixtures/test-gaming-thumbnail-config-plugin.ts', import.meta.url),
        ),
      },
    ],
    databaseUrl: db.url,
  });
  await seedMinimal(app.container, { playerCount: 1 });
  admin = await asAdmin(app.app);
  player = await asPlayer(app.app, { email: 'player.1@demo.igaming.dev' });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.dispose();
});

describe('gaming custom thumbnail e2e (PATCH /backoffice/gaming/games/{id})', () => {
  it('sets, reads back and clears a custom thumbnail, leaving the aggregator thumbnailUrl untouched, and audits both writes', async () => {
    const provider = await seedProvider();
    const created = await seedGame(provider.id);

    const setRes = await admin.patch(`/backoffice/gaming/games/${created.id}`, {
      id: created.id,
      customThumbnailUrl: 'https://cdn.example/custom.png',
    });
    expect(setRes.status).toBe(200);
    expect(await readJson(setRes)).toMatchObject({
      thumbnailUrl: 'https://cdn.example/aggregator.png',
      customThumbnailUrl: 'https://cdn.example/custom.png',
    });

    const getRes = await app.app.request(`/gaming/games/${created.id}`);
    expect(getRes.status).toBe(200);
    expect(await readJson(getRes)).toMatchObject({
      thumbnailUrl: 'https://cdn.example/aggregator.png',
      customThumbnailUrl: 'https://cdn.example/custom.png',
    });

    const clearRes = await admin.patch(`/backoffice/gaming/games/${created.id}`, {
      id: created.id,
      customThumbnailUrl: null,
    });
    expect(clearRes.status).toBe(200);
    expect(await readJson(clearRes)).toMatchObject({
      thumbnailUrl: 'https://cdn.example/aggregator.png',
      customThumbnailUrl: null,
    });

    await vi.waitFor(async () => {
      const rows = await gameUpdatedAuditRows(created.id);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        before: { customThumbnailUrl: null },
        after: { customThumbnailUrl: 'https://cdn.example/custom.png' },
      });
      expect(rows[1]).toMatchObject({
        before: { customThumbnailUrl: 'https://cdn.example/custom.png' },
        after: { customThumbnailUrl: null },
      });
    });
  });

  it('persists and returns the normalized href, not the raw input', async () => {
    const provider = await seedProvider();
    const created = await seedGame(provider.id);

    const res = await admin.patch(`/backoffice/gaming/games/${created.id}`, {
      id: created.id,
      customThumbnailUrl: 'HTTPS://cdn.example/x"><b>',
    });
    expect(res.status).toBe(200);
    const normalized = 'https://cdn.example/x%22%3E%3Cb%3E';
    expect(await readJson(res)).toMatchObject({ customThumbnailUrl: normalized });

    const [row] = await drizzleOf(app.container)
      .select({ customThumbnailUrl: game.customThumbnailUrl })
      .from(game)
      .where(eq(game.id, created.id));
    expect(row).toMatchObject({ customThumbnailUrl: normalized });

    const getRes = await app.app.request(`/gaming/games/${created.id}`);
    expect(await readJson(getRes)).toMatchObject({ customThumbnailUrl: normalized });
  });

  it('rejects a non-https customThumbnailUrl with 400', async () => {
    const provider = await seedProvider();
    const created = await seedGame(provider.id);

    const res = await admin.patch(`/backoffice/gaming/games/${created.id}`, {
      id: created.id,
      customThumbnailUrl: 'http://cdn.example/insecure.png',
    });
    expect(res.status).toBe(400);

    const rows = await gameUpdatedAuditRows(created.id);
    expect(rows).toHaveLength(0);
  });

  it('rejects a custom thumbnail whose host is not allowlisted, with 400 and no audit row', async () => {
    const provider = await seedProvider();
    const created = await seedGame(provider.id);

    const res = await admin.patch(`/backoffice/gaming/games/${created.id}`, {
      id: created.id,
      customThumbnailUrl: 'https://evil.example/tracker.png',
    });
    expect(res.status).toBe(400);

    const [row] = await drizzleOf(app.container)
      .select({ customThumbnailUrl: game.customThumbnailUrl })
      .from(game)
      .where(eq(game.id, created.id));
    expect(row).toMatchObject({ customThumbnailUrl: null });

    const rows = await gameUpdatedAuditRows(created.id);
    expect(rows).toHaveLength(0);
  });

  it('denies the PATCH to a caller without game-config:update', async () => {
    const provider = await seedProvider();
    const created = await seedGame(provider.id);

    const res = await player.patch(`/backoffice/gaming/games/${created.id}`, {
      id: created.id,
      customThumbnailUrl: 'https://cdn.example/custom.png',
    });
    expect(res.status).toBe(403);

    const rows = await gameUpdatedAuditRows(created.id);
    expect(rows).toHaveLength(0);
  });
});

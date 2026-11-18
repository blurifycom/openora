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
  type TestApp,
  type TestClient,
  type TestDb,
  bootE2e,
  closeE2e,
  flushAudit,
  readJson,
} from '../index.js';

let db: TestDb;
let app: TestApp;
let admin: TestClient;
let player: TestClient;

const VENDOR_LOGO = 'https://vendor.example/logo.png';

function drizzleOf(container: Container<CoreTokenCatalog>) {
  return container.get(DRIZZLE).db;
}

async function seedProvider() {
  const [row] = await drizzleOf(app.container)
    .insert(gameProvider)
    .values({
      slug: `e2e-custom-logo-provider-${randomUUID()}`,
      name: 'E2E Custom Logo Provider',
      logoUrl: VENDOR_LOGO,
      isActive: true,
    })
    .returning();
  if (!row) {
    throw new Error('failed to seed a game provider');
  }
  return row;
}

async function storedCustomLogo(providerId: string) {
  const [row] = await drizzleOf(app.container)
    .select({ customLogoUrl: gameProvider.customLogoUrl })
    .from(gameProvider)
    .where(eq(gameProvider.id, providerId));
  return row?.customLogoUrl;
}

async function providerUpdatedAuditRows(providerId: string) {
  await flushAudit(app);
  return drizzleOf(app.container)
    .select({ before: auditLog.before, after: auditLog.after })
    .from(auditLog)
    .where(and(eq(auditLog.action, 'gaming.provider.updated'), eq(auditLog.resourceId, providerId)))
    .orderBy(asc(auditLog.seq));
}

beforeAll(async () => {
  ({ db, app } = await bootE2e({
    plugins: [
      ...(await loadExtensions()),
      {
        id: 'testing-gaming-thumbnail-config',
        path: fileURLToPath(
          new URL('./fixtures/test-gaming-thumbnail-config-plugin.ts', import.meta.url),
        ),
      },
    ],
    seed: { playerCount: 1 },
  }));
  admin = await asAdmin(app.app);
  player = await asPlayer(app.app, { email: 'player.1@demo.igaming.dev' });
}, 60_000);

afterAll(async () => {
  await closeE2e({ app, db });
});

describe('gaming provider custom logo e2e (PATCH /backoffice/gaming/providers/{id})', () => {
  it('sets, keeps on an unrelated PATCH, and clears a custom logo, leaving logoUrl untouched, and audits each write', async () => {
    const provider = await seedProvider();
    const [created] = await drizzleOf(app.container)
      .insert(game)
      .values({
        reviewStatus: 'approved',
        name: 'E2E Custom Logo Game',
        slug: `e2e-custom-logo-game-${randomUUID()}`,
        providerId: provider.id,
        aggregator: 'direct',
        isActive: true,
      })
      .returning();

    const setRes = await admin.patch(`/backoffice/gaming/providers/${provider.id}`, {
      id: provider.id,
      customLogoUrl: 'https://cdn.example/custom.png',
    });
    expect(setRes.status).toBe(200);
    expect(await readJson(setRes)).toMatchObject({
      logoUrl: VENDOR_LOGO,
      customLogoUrl: 'https://cdn.example/custom.png',
    });

    const adminGet = await admin.get(`/backoffice/gaming/providers/${provider.id}`);
    expect(await readJson(adminGet)).toMatchObject({
      customLogoUrl: 'https://cdn.example/custom.png',
    });
    const publicGet = await app.app.request(`/gaming/providers/${provider.slug}`);
    expect(publicGet.status).toBe(200);
    expect(await readJson(publicGet)).toMatchObject({
      logoUrl: VENDOR_LOGO,
      customLogoUrl: 'https://cdn.example/custom.png',
    });
    const gameGet = await app.app.request(`/gaming/games/${created!.id}`);
    expect(await readJson(gameGet)).toMatchObject({
      provider: { logoUrl: VENDOR_LOGO, customLogoUrl: 'https://cdn.example/custom.png' },
    });

    const renameRes = await admin.patch(`/backoffice/gaming/providers/${provider.id}`, {
      id: provider.id,
      name: 'Renamed Provider',
    });
    expect(renameRes.status).toBe(200);
    expect(await readJson(renameRes)).toMatchObject({
      customLogoUrl: 'https://cdn.example/custom.png',
    });

    const clearRes = await admin.patch(`/backoffice/gaming/providers/${provider.id}`, {
      id: provider.id,
      customLogoUrl: null,
    });
    expect(clearRes.status).toBe(200);
    expect(await readJson(clearRes)).toMatchObject({ logoUrl: VENDOR_LOGO, customLogoUrl: null });

    await vi.waitFor(async () => {
      const rows = await providerUpdatedAuditRows(provider.id);
      expect(rows).toHaveLength(3);
      expect(rows[0]).toMatchObject({
        before: { customLogoUrl: null },
        after: { customLogoUrl: 'https://cdn.example/custom.png' },
      });
      expect(rows[2]).toMatchObject({
        before: { customLogoUrl: 'https://cdn.example/custom.png' },
        after: { customLogoUrl: null, logoUrl: VENDOR_LOGO },
      });
    });
  });

  it.each([
    ['a non-https URL', 'http://cdn.example/insecure.png'],
    ['embedded credentials', 'https://user:pass@cdn.example/logo.png'],
    ['an unlisted host', 'https://evil.example/tracker.png'],
  ])('rejects %s with 400, no write and no audit row', async (_case, customLogoUrl) => {
    const provider = await seedProvider();

    const res = await admin.patch(`/backoffice/gaming/providers/${provider.id}`, {
      id: provider.id,
      customLogoUrl,
    });
    expect(res.status).toBe(400);
    expect(await storedCustomLogo(provider.id)).toBeNull();
    expect(await providerUpdatedAuditRows(provider.id)).toHaveLength(0);
  });

  it('denies the PATCH to a caller without game-config:update', async () => {
    const provider = await seedProvider();

    const res = await player.patch(`/backoffice/gaming/providers/${provider.id}`, {
      id: provider.id,
      customLogoUrl: 'https://cdn.example/custom.png',
    });
    expect(res.status).toBe(403);
    expect(await storedCustomLogo(provider.id)).toBeNull();
  });
});

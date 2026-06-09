import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DrizzleService } from '@oss/db';
import { orm } from '@oss/db';
import { DEFAULT_TENANT_ID } from '@oss/shared-schemas';
import { game } from '@oss/modules/player/gaming/schema';
import { wallet } from '@oss/modules/player/wallet/schema';
import { user } from '@oss/modules/platform/identity/schema';
import { DRIZZLE } from '@oss/db';
import { startHarness, type IntegrationHarness } from './harness.js';
import { setupTestDb } from '@oss/testing';

const { eq } = orm;

// Covers the default/public-tenant seam (ADR-0018/0019):
//  - the anonymous public lobby returns the DEFAULT_TENANT_ID's active games only,
//    and does NOT leak another tenant's games (explicit server-side filter);
//  - a self-registered user is stamped with DEFAULT_TENANT_ID and can read its own
//    scoped data under the REAL RLS-enforced `oss_app` role.
describe('default-tenant seam (integration)', () => {
  let h: IntegrationHarness;

  beforeAll(async () => {
    h = await startHarness();
  });

  afterAll(async () => {
    await h?.stop();
  });

  describe('anonymous public lobby', () => {
    const OTHER_TENANT = 'other-brand';

    beforeAll(async () => {
      // Seed an active game under a DIFFERENT tenant via the BYPASSRLS admin db. If
      // the public lobby ever leaked cross-tenant, this would show up in the result.
      const adminDb = h.container.get(DRIZZLE).adminDb;
      await adminDb.insert(game).values({
        tenantId: OTHER_TENANT,
        name: 'Other Brand Exclusive',
        provider: 'mock',
        category: 'slots',
        isActive: true,
      });
    });

    it('returns the default tenant games and never another tenant game', async () => {
      // No cookie -> no verified tenant -> the public catalog path (listPublicGames).
      const res = await h.app.request('/gaming/games', { method: 'GET' });
      expect(res.status).toBe(200);
      const games = (await res.json()) as Array<{ name: string }>;

      // The seeded demo games (DEFAULT_TENANT_ID) are visible...
      expect(games.length).toBeGreaterThan(0);
      // ...and the other tenant's game is NOT leaked.
      expect(games.some((g) => g.name === 'Other Brand Exclusive')).toBe(false);
    });
  });

  describe('self-registration tenanting', () => {
    const email = `newcomer-${Date.now()}@demo.igaming.dev`;

    it('stamps DEFAULT_TENANT_ID on a freshly registered user', async () => {
      const res = await h.app.request('/identity/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'password123', name: 'Newcomer' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { user: { id: string } };
      const userId = body.user.id;

      // The `user` table is not RLS-scoped - read it on the admin db.
      const adminDb = h.container.get(DRIZZLE).adminDb;
      const rows = await adminDb
        .select({ tenantId: user.tenantId })
        .from(user)
        .where(eq(user.id, userId))
        .limit(1);
      expect(rows[0]?.tenantId).toBe(DEFAULT_TENANT_ID);
    });

    // Prove the registered user can actually READ its own scoped data under the
    // genuinely-enforced RLS role (oss_app), using the same pattern the RLS
    // isolation test uses (the harness app pool is a superuser and bypasses RLS).
    it('lets the registered user read its own scoped row under the RLS role', async () => {
      const adminDb = h.container.get(DRIZZLE).adminDb;
      const rows = await adminDb
        .select({ id: user.id })
        .from(user)
        .where(eq(user.email, email))
        .limit(1);
      const userId = rows[0]?.id;
      expect(userId).toBeTruthy();

      // Create a scoped wallet row for this user, under DEFAULT_TENANT_ID, via admin.
      await adminDb.insert(wallet).values({
        userId: userId!,
        tenantId: DEFAULT_TENANT_ID,
        balance: '25',
        currency: 'USD',
      });

      // Now read it back through the enforced app role pinned to the resolved tenant.
      const testDb = await setupTestDb();
      const appUrl = new URL(testDb.url);
      appUrl.username = 'oss_app';
      appUrl.password = 'oss_app_dev';
      const prevUrl = process.env['DATABASE_URL'];
      const prevAdmin = process.env['DATABASE_ADMIN_URL'];
      process.env['DATABASE_URL'] = appUrl.toString();
      process.env['DATABASE_ADMIN_URL'] = testDb.url;
      const rls = new DrizzleService();
      try {
        const seen = await rls.runWithTenant(DEFAULT_TENANT_ID, async () => {
          return rls.db
            .select({ balance: wallet.balance })
            .from(wallet)
            .where(eq(wallet.userId, userId!));
        });
        expect(seen.map((r) => r.balance)).toContain('25');
      } finally {
        await rls.dispose();
        await testDb.dispose();
        if (prevUrl === undefined) delete process.env['DATABASE_URL'];
        else process.env['DATABASE_URL'] = prevUrl;
        if (prevAdmin === undefined) delete process.env['DATABASE_ADMIN_URL'];
        else process.env['DATABASE_ADMIN_URL'] = prevAdmin;
      }
    });
  });
});

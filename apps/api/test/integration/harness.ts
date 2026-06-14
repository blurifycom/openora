import { setupTestDb, bootTestApp, seedMinimal, asPlayer, asAdmin } from '@oss/testing';
import type { TestApp, TestClient } from '@oss/testing';
import type { Container } from '@oss/core';
import { DRIZZLE } from '@oss/db';
import { eq } from '@oss/db/orm';
import { player } from '@oss-addons/profile/schema';
import { user } from '@oss-addons/identity/schema';
import { loadExtensions } from '../../src/extensions.js';

export type IntegrationHarness = {
  app: TestApp['app'];
  container: Container;
  /** A seeded player's userId (for asserting ownership / building fixtures). */
  playerId: string;
  /** The same seeded player's email (used to log in via a real session). */
  playerEmail: string;
  /**
   * A client carrying the seeded player's VERIFIED session cookie. Logs in with
   * the player's real credentials - no `x-user-id` trust. Pass an email to act as
   * a different seeded player; defaults to the harness's primary player.
   */
  asPlayer(email?: string): Promise<TestClient>;
  asAdmin(): Promise<TestClient>;
  stop(): Promise<void>;
};

/**
 * Boot the full app against the test DB, wipe it, and seed a small fixture.
 * Each integration file calls this in `beforeAll` and `harness.stop()` in
 * `afterAll`. Suites run single-threaded (see vitest.integration.config.ts), so
 * they never share a live DB concurrently.
 */
export async function startHarness(): Promise<IntegrationHarness> {
  const db = await setupTestDb();
  const plugins = await loadExtensions();
  const booted = await bootTestApp({ plugins, databaseUrl: db.url });
  await db.truncateAll();
  await seedMinimal(booted.container, { playerCount: 4 });

  // Seed/admin reads cross tenants, so use the BYPASSRLS admin db (no request GUC).
  const adminDb = booted.container.get(DRIZZLE).adminDb;
  const rows = await adminDb.select().from(player).limit(1);
  const playerId = rows[0]?.userId;
  if (!playerId) throw new Error('startHarness: seed produced no players');
  const userRows = await adminDb
    .select({ email: user.email })
    .from(user)
    .where(eq(user.id, playerId))
    .limit(1);
  const playerEmail = userRows[0]?.email;
  if (!playerEmail) throw new Error('startHarness: seeded player has no user email');

  return {
    app: booted.app,
    container: booted.container,
    playerId,
    playerEmail,
    asPlayer: (email = playerEmail) => asPlayer(booted.app, { email }),
    asAdmin: () => asAdmin(booted.app),
    async stop() {
      await booted.close();
      await db.dispose();
    },
  };
}

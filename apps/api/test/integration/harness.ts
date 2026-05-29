import { setupTestDb, bootTestApp, seedMinimal, asPlayer, asAdmin } from '@oss/testing';
import type { TestApp, TestClient } from '@oss/testing';
import type { Container } from '@oss/core';
import { DRIZZLE } from '@oss/db';
import { player } from '@oss/modules/backoffice/player-management/schema';
import { loadExtensions } from '../../src/extensions.js';

export interface IntegrationHarness {
  app: TestApp['app'];
  container: Container;
  /** A seeded player's userId, for `asPlayer(app, id)`. */
  playerId: string;
  asPlayer(userId?: string): TestClient;
  asAdmin(): Promise<TestClient>;
  stop(): Promise<void>;
}

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

  const rows = await booted.container.get(DRIZZLE).db.select().from(player).limit(1);
  const playerId = rows[0]?.userId;
  if (!playerId) throw new Error('startHarness: seed produced no players');

  return {
    app: booted.app,
    container: booted.container,
    playerId,
    asPlayer: (userId = playerId) => asPlayer(booted.app, userId),
    asAdmin: () => asAdmin(booted.app),
    async stop() {
      await booted.close();
      await db.dispose();
    },
  };
}

import { loadExtensions } from '@openora/core/server';
import { setupTestDb, type TestDb } from './db.js';
import { bootTestApp, type BootTestAppConfig, type TestApp } from './app.js';
import { seedMinimal, type SeedMinimalOptions } from './seed.js';

export type E2e = { db: TestDb; app: TestApp };

export type BootE2eOptions = {
  /** Defaults to `loadExtensions()`. */
  plugins?: BootTestAppConfig['plugins'];
  /** Defaults to `{ playerCount: 0 }`; `false` skips seeding. */
  seed?: SeedMinimalOptions | false;
};

/** Own test database + booted app + minimal seed. Pair with `closeE2e` in `afterAll`. */
export async function bootE2e(options: BootE2eOptions = {}): Promise<E2e> {
  const db = await setupTestDb();
  let app: TestApp | undefined;
  try {
    app = await bootTestApp({
      plugins: options.plugins ?? (await loadExtensions()),
      databaseUrl: db.url,
    });
    if (options.seed !== false) {
      await seedMinimal(app.container, options.seed ?? { playerCount: 0 });
    }
    return { db, app };
  } catch (err) {
    await closeE2e({ app, db }).catch((cleanupErr: unknown) => {
      console.error('closeE2e failed while cleaning up a failed boot', cleanupErr);
    });
    throw err;
  }
}

/** Tolerates a half-booted suite (either handle undefined). */
export async function closeE2e({
  app,
  db,
}: {
  app?: TestApp | undefined;
  db?: TestDb | undefined;
}): Promise<void> {
  try {
    await app?.close();
  } finally {
    await db?.dispose();
  }
}

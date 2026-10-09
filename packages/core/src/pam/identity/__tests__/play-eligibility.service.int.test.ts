import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, type TestDb, seedUser } from '@openora/core/testing';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { migrate } from '../migrate.js';
import { PlayEligibilityService } from '../service/play-eligibility.service.js';

// A one-connection pool: a transaction holds the only connection, so any read that asks the
// pool for another one is the starvation a full pool of concurrent wagers would hit.
const POOL_ENV = { DATABASE_POOL_MAX: '1', DATABASE_POOL_ACQUIRE_TIMEOUT_MS: '300' } as const;

let db: TestDb;

beforeAll(async () => {
  Object.assign(process.env, POOL_ENV);
  db = await createTestDb([migrate, migrateProfile]);
});

afterAll(async () => {
  await db.drop();
  for (const name of Object.keys(POOL_ENV)) {
    delete process.env[name];
  }
});

describe('PlayEligibilityService inside a caller transaction (real PG)', () => {
  it('answers on the caller transaction while it holds the only pool connection', async () => {
    const player = await seedUser(db);
    const svc = new PlayEligibilityService(db.drizzle);

    const restricted = await db.drizzle.db.transaction((tx) => svc.isRestricted(player.id, tx));

    expect(restricted).toBe(false);
  });

  it('fails fast, instead of hanging, when a read asks the exhausted pool for a second connection', async () => {
    const player = await seedUser(db);
    const svc = new PlayEligibilityService(db.drizzle);

    await expect(
      db.drizzle.db.transaction(() => svc.isRestricted(player.id)),
    ).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/timeout exceeded when trying to connect/) },
    });
  });
});

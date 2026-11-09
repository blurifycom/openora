import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { createTestDb, type TestDb, seedUser } from '@openora/core/testing';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { player as playerTable } from '@openora/core/pam/schema/profile';
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

  it('holds a concurrent restriction back until the caller transaction ends', async () => {
    const player = await seedUser(db);
    const svc = new PlayEligibilityService(db.drizzle);
    const other = new Client({ connectionString: db.url });
    await other.connect();

    try {
      await other.query(`SET lock_timeout = '200ms'`);
      await db.drizzle.db.transaction(async (tx) => {
        await svc.isRestricted(player.id, tx);
        await expect(
          other.query('UPDATE "user" SET rg_blocked = true WHERE id = $1', [player.id]),
        ).rejects.toMatchObject({ code: '55P03' });
      });
    } finally {
      await other.end();
    }
  });
});

describe('PlayEligibilityService player status (real PG)', () => {
  it.each([
    ['suspended', 'account_suspended'],
    ['closed', 'account_closed'],
  ] as const)('refuses play for a %s player', async (status, reason) => {
    const account = await seedUser(db);
    await db.drizzle.db.insert(playerTable).values({ userId: account.id, currency: 'USD', status });
    const svc = new PlayEligibilityService(db.drizzle);

    expect(await svc.checkPlay(account.id)).toBe(reason);
    expect(await db.drizzle.db.transaction((tx) => svc.checkPlay(account.id, tx))).toBe(reason);
    expect(await svc.isRestricted(account.id)).toBe(false);
  });

  it('admits an active player', async () => {
    const account = await seedUser(db);
    await db.drizzle.db.insert(playerTable).values({ userId: account.id, currency: 'USD' });
    const svc = new PlayEligibilityService(db.drizzle);

    expect(await svc.checkPlay(account.id)).toBeNull();
  });

  it('holds a concurrent suspension back until the caller transaction ends', async () => {
    const account = await seedUser(db);
    await db.drizzle.db.insert(playerTable).values({ userId: account.id, currency: 'USD' });
    const svc = new PlayEligibilityService(db.drizzle);
    const other = new Client({ connectionString: db.url });
    await other.connect();

    try {
      await other.query(`SET lock_timeout = '200ms'`);
      await db.drizzle.db.transaction(async (tx) => {
        await svc.checkPlay(account.id, tx);
        await expect(
          other.query(`UPDATE player SET status = 'suspended' WHERE user_id = $1`, [account.id]),
        ).rejects.toMatchObject({ code: '55P03' });
      });
    } finally {
      await other.end();
    }
  });
});

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { findOneOrThrow } from '@openora/core/server';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { player } from '@openora/core/pam/schema/profile';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { migrate } from '../migrate.js';
import { IdentityReaderService } from '../adapters/identity-reader.service.js';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb([migrate, migrateProfile]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(sql`TRUNCATE ${player} RESTART IDENTITY CASCADE`);
});

describe('IdentityReaderService.getUserIdByPlayerId (real PG)', () => {
  it('resolves a player id to the user id that owns the profile', async () => {
    const reader = new IdentityReaderService(db.drizzle);
    const row = findOneOrThrow(
      await db.drizzle.db.insert(player).values({ userId: randomUUID() }).returning(),
      new Error('player insert returned no row'),
    );
    await db.drizzle.db.insert(player).values({ userId: randomUUID() });

    expect(await reader.getUserIdByPlayerId(row.id)).toBe(row.userId);
  });

  it('resolves an unknown player id to null', async () => {
    const reader = new IdentityReaderService(db.drizzle);

    expect(await reader.getUserIdByPlayerId(randomUUID())).toBeNull();
  });
});

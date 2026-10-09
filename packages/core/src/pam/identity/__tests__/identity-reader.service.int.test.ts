import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { createTestDb, type TestDb, seedPlayerWithUser } from '@openora/core/testing';
import { player } from '@openora/core/pam/schema/profile';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { migrate } from '../migrate.js';
import { session, user } from '../schema/index.js';
import { IdentityReaderService } from '../adapters/identity-reader.service.js';

const SHARED_IP = '203.0.113.20';

let db: TestDb;

async function seedLoginFromSharedIp(role: 'player' | 'admin') {
  const { account } = await seedPlayerWithUser(db);
  await db.drizzle.db.update(user).set({ role }).where(eq(user.id, account.id));
  await db.drizzle.db.insert(session).values({
    userId: account.id,
    token: randomUUID(),
    expiresAt: new Date(Date.now() + 86_400_000),
    ipAddress: SHARED_IP,
  });
  return account.id;
}

beforeAll(async () => {
  db = await createTestDb([migrate, migrateProfile]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${session}, ${player}, ${user} RESTART IDENTITY CASCADE`,
  );
});

describe('IdentityReaderService.getPlayerUserIdsSharingLoginIp (real PG)', () => {
  it('links a player to the other players on the IP, not to staff', async () => {
    const playerId = await seedLoginFromSharedIp('player');
    const otherPlayerId = await seedLoginFromSharedIp('player');
    await seedLoginFromSharedIp('admin');

    const linked = await new IdentityReaderService(db.drizzle).getPlayerUserIdsSharingLoginIp(
      playerId,
      SHARED_IP,
    );

    expect(linked).toEqual([otherPlayerId]);
  });

  it('links no one to a staff login, even when the staff account has a player profile', async () => {
    await seedLoginFromSharedIp('player');
    const staffId = await seedLoginFromSharedIp('admin');

    const linked = await new IdentityReaderService(db.drizzle).getPlayerUserIdsSharingLoginIp(
      staffId,
      SHARED_IP,
    );

    expect(linked).toEqual([]);
  });
});

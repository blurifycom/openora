import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { createTestDb, seedPlayerWithUser, seedUser, type TestDb } from '@openora/core/testing';
import { player } from '@openora/core/pam/schema/profile';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { migrate } from '../migrate.js';
import { user } from '../schema/index.js';
import { IdentityReaderService } from '../adapters/identity-reader.service.js';

let db: TestDb;
let reader: IdentityReaderService;
let userIds: string[];

beforeAll(async () => {
  db = await createTestDb([migrate, migrateProfile]);
  reader = new IdentityReaderService(db.drizzle);
  const players = await Promise.all([
    seedPlayerWithUser(db, { country: 'DE', firstName: 'Ada', lastName: 'Lovelace' }),
    seedPlayerWithUser(db, { hideUsernameOnLeaderboards: true, status: 'closed' }),
    seedPlayerWithUser(db, { status: 'self_excluded' }),
  ]);
  const staff = await seedUser(db, { role: 'admin', language: 'pl' });
  userIds = [...players.map((p) => p.account.id), staff.id, randomUUID()];
});

afterAll(async () => {
  await db.drop();
});

const sorted = <T>(map: Map<string, T>) => [...map].sort(([a], [b]) => a.localeCompare(b));

describe('IDENTITY_READER answers what the old money-side joins did', () => {
  it('getPlayerIdsByUserIds: the player id a left join on the player table found', async () => {
    const rows = await db.drizzle.db
      .select({ userId: player.userId, id: player.id })
      .from(player)
      .where(inArray(player.userId, userIds));

    expect(sorted(await reader.getPlayerIdsByUserIds(userIds))).toEqual(
      sorted(new Map(rows.map((row) => [row.userId, row.id]))),
    );
  });

  it('getLeaderboardNames: the inner join on user, left join on player', async () => {
    const rows = await db.drizzle.db
      .select({
        userId: user.id,
        username: user.username,
        hideUsername: player.hideUsernameOnLeaderboards,
      })
      .from(user)
      .leftJoin(player, eq(player.userId, user.id))
      .where(inArray(user.id, userIds));
    const old = new Map(
      rows.map((row) => [
        row.userId,
        { username: row.username, hideUsername: row.hideUsername ?? false },
      ]),
    );

    expect(sorted(await reader.getLeaderboardNames(userIds))).toEqual(sorted(old));
  });

  it('getUserContacts: name and email off the user table', async () => {
    const rows = await db.drizzle.db
      .select({ userId: user.id, name: user.name, email: user.email })
      .from(user)
      .where(inArray(user.id, userIds));
    const old = new Map(rows.map(({ userId, ...contact }) => [userId, contact]));

    expect(sorted(await reader.getUserContacts(userIds))).toEqual(sorted(old));
  });

  it('getPlayerFacts: country and legal name off player, language off user', async () => {
    const rows = await db.drizzle.db
      .select({
        userId: user.id,
        country: player.country,
        firstName: player.firstName,
        lastName: player.lastName,
        preferredLanguage: user.language,
      })
      .from(user)
      .leftJoin(player, eq(player.userId, user.id))
      .where(inArray(user.id, userIds));
    const old = new Map(rows.map(({ userId, ...facts }) => [userId, facts]));

    const facts = await reader.getPlayerFacts(userIds);
    expect(sorted(facts)).toEqual(sorted(old));
    expect(facts.get(userIds[0] ?? '')).toMatchObject({ country: 'DE', firstName: 'Ada' });
  });
});

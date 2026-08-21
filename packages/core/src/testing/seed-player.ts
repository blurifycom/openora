import { randomUUID } from 'node:crypto';
import { player } from '../pam/profile/schema/index.js';
import { user } from '../pam/identity/schema/index.js';
import type { TestDb } from './real-infra.js';

export type SeedPlayerOverrides = Partial<typeof player.$inferInsert> & { username?: string };

/**
 * Inserts a verified `user` plus its `player` row. An explicit `displayName` also
 * fixes the username so tests can assert on it; otherwise the handle is unique per
 * seed, keeping the partial unique index collision-free.
 */
export async function seedPlayerWithUser(db: TestDb, overrides: SeedPlayerOverrides = {}) {
  const { username, ...playerOverrides } = overrides;
  const userId = playerOverrides.userId ?? randomUUID();
  const derivedUsername = playerOverrides.displayName
    ? playerOverrides.displayName.toLowerCase().replaceAll(/[^a-z0-9_]+/g, '_')
    : `player_${userId.replaceAll('-', '').slice(0, 12)}`;

  const [account] = await db.drizzle.db
    .insert(user)
    .values({
      id: userId,
      name: playerOverrides.displayName ?? 'Player',
      username: username ?? derivedUsername,
      email: `${userId}@test.dev`,
      emailVerified: true,
    })
    .returning();
  const [row] = await db.drizzle.db
    .insert(player)
    .values({ displayName: 'Player', ...playerOverrides, userId })
    .returning();
  if (!account || !row) {
    throw new Error('seedPlayerWithUser: insert returned no row');
  }
  return { account, player: row };
}

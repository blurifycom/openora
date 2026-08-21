import { randomUUID } from 'node:crypto';
import { player } from '../pam/profile/schema/index.js';
import { user } from '../pam/identity/schema/index.js';
import type { TestDb } from './real-infra.js';

export type SeedPlayerOverrides = Partial<typeof player.$inferInsert> & { username?: string };

/**
 * Inserts a verified `user` plus its `player` row. The username defaults to a handle
 * unique per seed, so the case-insensitive unique index never collides across tests.
 */
export async function seedPlayerWithUser(db: TestDb, overrides: SeedPlayerOverrides = {}) {
  const { username, ...playerOverrides } = overrides;
  const userId = playerOverrides.userId ?? randomUUID();

  const [account] = await db.drizzle.db
    .insert(user)
    .values({
      id: userId,
      name: username ?? 'Player',
      username: username ?? `player_${userId.replaceAll('-', '').slice(0, 12)}`,
      email: `${userId}@test.dev`,
      emailVerified: true,
    })
    .returning();
  const [row] = await db.drizzle.db
    .insert(player)
    .values({ ...playerOverrides, userId })
    .returning();
  if (!account || !row) {
    throw new Error('seedPlayerWithUser: insert returned no row');
  }
  return { account, player: row };
}

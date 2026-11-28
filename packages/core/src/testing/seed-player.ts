import { randomUUID } from 'node:crypto';
import { player } from '../pam/profile/schema/index.js';
import { user } from '../pam/identity/schema/index.js';
import type { TestDb } from './real-infra.js';

export function uniqueUsername(prefix = 'player'): string {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

export async function seedUser(db: TestDb, overrides: Partial<typeof user.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(user)
    .values({
      name: 'Player',
      username: uniqueUsername(),
      email: `${randomUUID()}@test.dev`,
      emailVerified: true,
      ...overrides,
    })
    .returning();
  if (!row) {
    throw new Error('seedUser: insert returned no row');
  }
  return row;
}

export type SeedPlayerOverrides = Partial<typeof player.$inferInsert> & { username?: string };

export async function seedPlayerWithUser(db: TestDb, overrides: SeedPlayerOverrides = {}) {
  const { username, ...playerOverrides } = overrides;
  const userId = playerOverrides.userId ?? randomUUID();
  const account = await seedUser(db, {
    id: userId,
    ...(username ? { name: username, username } : {}),
    email: `${userId}@test.dev`,
  });
  const [row] = await db.drizzle.db
    .insert(player)
    .values({ ...playerOverrides, userId })
    .returning();
  if (!row) {
    throw new Error('seedPlayerWithUser: insert returned no row');
  }
  return { account, player: row };
}

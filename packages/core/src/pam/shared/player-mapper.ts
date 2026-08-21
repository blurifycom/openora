import { eq } from 'drizzle-orm';
import type { DrizzleService } from '@openora/core/server';
import type { User } from '@openora/core/contracts';
import { player } from '../profile/schema/index.js';
import { user } from '../identity/schema/index.js';

export function toPlayer(row: typeof player.$inferSelect, email: string, username: string) {
  return {
    id: row.id,
    userId: row.userId,
    username,
    email,
    country: row.country,
    currency: row.currency,
    status: row.status,
    kycStatus: row.kycStatus,
    level: row.level,
    totalWagered: row.totalWagered,
    totalDeposits: row.totalDeposits,
    lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function fetchEmailByUserId(
  drizzle: DrizzleService,
  userId: User['id'],
): Promise<string> {
  const [record] = await drizzle.db
    .select({ email: user.email })
    .from(user)
    .where(eq(user.id, userId));
  return record?.email ?? '';
}

export async function fetchUsernameByUserId(
  drizzle: DrizzleService,
  userId: User['id'],
): Promise<string> {
  const [record] = await drizzle.db
    .select({ username: user.username })
    .from(user)
    .where(eq(user.id, userId));
  return record?.username ?? '';
}

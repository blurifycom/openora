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
    firstName: row.firstName,
    lastName: row.lastName,
    // Already a 'YYYY-MM-DD' string - the column is a `date` in string mode, unlike the
    // timestamps below.
    dateOfBirth: row.dateOfBirth,
    phone: row.phone,
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

/** The identity columns `toPlayer` needs, or null when the user row is gone. */
export async function fetchIdentityByUserId(drizzle: DrizzleService, userId: User['id']) {
  const [record] = await drizzle.db
    .select({ email: user.email, username: user.username })
    .from(user)
    .where(eq(user.id, userId));
  return record ?? null;
}

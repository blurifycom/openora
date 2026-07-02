import { eq } from 'drizzle-orm';
import type { DrizzleService } from '@blurifycom/core/server';
import type { Player, PlayerStatus, KycStatus } from '@blurifycom/core/contracts';
import { player } from '../profile/schema/index.js';
import { user } from '../identity/schema/index.js';

export function toPlayer(row: typeof player.$inferSelect, email: string): Player {
  return {
    id: row.id,
    userId: row.userId,
    displayName: row.displayName,
    email,
    country: row.country,
    currency: row.currency,
    language: row.language,
    status: row.status as PlayerStatus,
    kycStatus: row.kycStatus as KycStatus,
    level: row.level,
    totalWagered: Number(row.totalWagered),
    totalDeposits: Number(row.totalDeposits),
    lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function fetchEmail(drizzle: DrizzleService, userId: string): Promise<string> {
  const [record] = await drizzle.db
    .select({ email: user.email })
    .from(user)
    .where(eq(user.id, userId));
  return record?.email ?? '';
}

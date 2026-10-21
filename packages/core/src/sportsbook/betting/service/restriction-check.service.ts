import { eq } from 'drizzle-orm';
import type { DrizzleDb, DrizzleTx } from '@openora/core/server';
import type { User } from '@openora/core/contracts';
import { sportsbookPlayerRestriction } from '../schema/index.js';

export async function isPlayerRestricted(
  db: DrizzleDb | DrizzleTx,
  userId: User['id'],
): Promise<boolean> {
  const [row] = await db
    .select({ userId: sportsbookPlayerRestriction.userId })
    .from(sportsbookPlayerRestriction)
    .where(eq(sportsbookPlayerRestriction.userId, userId));
  return row !== undefined;
}

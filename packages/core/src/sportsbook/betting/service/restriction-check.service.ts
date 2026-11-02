import { eq } from 'drizzle-orm';
import type { DrizzleDb, DrizzleTx } from '@openora/core/server';
import type { PlayEligibilityPort, PlayRefusal, User } from '@openora/core/contracts';
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

/** Why the player may not play now; `player_blocked` when the bound port cannot name it. */
export async function playRefusal(
  playEligibility: PlayEligibilityPort,
  userId: User['id'],
  tx?: DrizzleTx,
): Promise<PlayRefusal | 'player_blocked' | null> {
  if (playEligibility.checkPlay) {
    return playEligibility.checkPlay(userId, tx);
  }
  return (await playEligibility.isRestricted(userId, tx)) ? 'player_blocked' : null;
}

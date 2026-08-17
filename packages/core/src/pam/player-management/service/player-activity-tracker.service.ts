import { DrizzleService } from '@openora/core/server';
import type { Player, PlayerActivityTracker } from '@openora/core/contracts';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { player } from '@openora/core/pam/schema/profile';

/**
 * Binds PLAYER_ACTIVITY_TRACKER. Called fire-and-forget from the per-request auth
 * middleware (create-app.ts) for every authenticated request, so the write is
 * throttled to once per minute per player rather than an unconditional write on the
 * hot path - the guard (`lastSeenAt IS NULL OR lastSeenAt < now() - 1 minute`) is a
 * single conditional UPDATE, not a select-then-update. This is the first writer of
 * `player.lastSeenAt` (previously dead); the Friends tab (BF-427) online/offline
 * derivation is the first reader, via SocialService.listFriends. This 1-minute
 * throttle window MUST stay smaller than listFriends's ONLINE_STATUS_WINDOW_MS
 * (currently 2 minutes, in social.service.ts) - otherwise an active player could
 * read as offline in the gap between two throttled writes.
 */
export class DrizzlePlayerActivityTracker implements PlayerActivityTracker {
  constructor(private readonly drizzle: DrizzleService) {}

  async touchLastSeen(userId: Player['userId']): Promise<void> {
    await this.drizzle.db
      .update(player)
      .set({ lastSeenAt: new Date() })
      .where(
        and(
          eq(player.userId, userId),
          or(isNull(player.lastSeenAt), lt(player.lastSeenAt, sql`now() - interval '1 minute'`)),
        ),
      );
  }
}

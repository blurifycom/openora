import { DrizzleService } from '@openora/core/server';
import type { Player, PlayerActivityTracker } from '@openora/core/contracts';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { player } from '@openora/core/pam/schema/profile';

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

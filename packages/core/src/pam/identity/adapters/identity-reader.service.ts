import { DrizzleService } from '@openora/core/server';
import { Player, type IdentityReader } from '@openora/core/contracts';
import { and, eq, isNull, lt, max, or } from 'drizzle-orm';
import { session, user } from '../schema/index.js';
import { player } from '@openora/core/pam/schema/profile';

export class IdentityReaderService implements IdentityReader {
  constructor(private readonly drizzle: DrizzleService) {}

  async getLastLoginAt(userId: Player['id']): Promise<Date | null> {
    const [row] = await this.drizzle.db
      .select({ lastAt: max(session.createdAt) })
      .from(session)
      .where(eq(session.userId, userId));
    return row?.lastAt ?? null;
  }

  async getPlayerIdsInactiveSince(sinceDate: Date): Promise<string[]> {
    // Join users to their most-recent session. Players with no session at all
    // (registered but never logged in) are included via the LEFT JOIN + isNull check.
    const lastSessionPerUser = this.drizzle.db
      .select({ userId: session.userId, lastAt: max(session.createdAt).as('last_at') })
      .from(session)
      .groupBy(session.userId)
      .as('s');

    const rows = await this.drizzle.db
      .select({ userId: user.id })
      .from(user)
      .leftJoin(lastSessionPerUser, eq(user.id, lastSessionPerUser.userId))
      .where(
        and(
          eq(user.role, 'player'),
          or(
            and(isNull(lastSessionPerUser.lastAt), lt(user.createdAt, sinceDate)),
            lt(lastSessionPerUser.lastAt, sinceDate),
          ),
        ),
      );
    return rows.map((r) => r.userId);
  }

  async getPlayerIdByUserId(userId: string): Promise<string | null> {
    const [row] = await this.drizzle.db
      .select({ id: player.id })
      .from(player)
      .where(eq(player.userId, userId))
      .limit(1);
    return row?.id ?? null;
  }
}

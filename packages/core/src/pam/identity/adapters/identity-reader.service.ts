import { createLogger, DrizzleService } from '@openora/core/server';
import type { IdentityReader, KycStatus, Player, User } from '@openora/core/contracts';
import { and, eq, inArray, isNull, lt, max, ne, or, SQL } from 'drizzle-orm';
import { session, user } from '../schema/index.js';
import { player } from '@openora/core/pam/schema/profile';

const logger = createLogger('identity-reader');

export class IdentityReaderService implements IdentityReader {
  constructor(private readonly drizzle: DrizzleService) {}

  async getLastLoginAt(userId: User['id']): Promise<Date | null> {
    const [row] = await this.drizzle.db
      .select({ lastAt: max(session.createdAt) })
      .from(session)
      .where(eq(session.userId, userId));
    return row?.lastAt ?? null;
  }

  async getPlayerIdsInactiveSince(sinceDate: Date): Promise<User['id'][]> {
    // Join users to their most-recent session. Players with no session at all
    // (registered but never logged in) are included via the LEFT JOIN + isNull check.
    const lastSessionPerUser = this.drizzle.db
      .select({
        userId: session.userId,
        lastAt: new SQL.Aliased<Date | null>(max(session.createdAt), 'last_at'),
      })
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

  async getPlayerIdByUserId(userId: User['id']): Promise<Player['id'] | null> {
    const [row] = await this.drizzle.db
      .select({ id: player.id })
      .from(player)
      .where(eq(player.userId, userId))
      .limit(1);
    return row?.id ?? null;
  }

  async getPlayerIdByUserIdSafe(userId: User['id']): Promise<Player['id'] | null> {
    try {
      return await this.getPlayerIdByUserId(userId);
    } catch (err) {
      logger.warn({ err, userId }, 'player id lookup failed for event enrichment');
      return null;
    }
  }

  async getPlayerIdsByUserIdsSafe(
    userIds: User['id'][],
  ): Promise<Map<User['id'], Player['id'] | null>> {
    const result = new Map<User['id'], Player['id'] | null>(userIds.map((id) => [id, null]));
    if (userIds.length === 0) {
      return result;
    }
    try {
      const rows = await this.drizzle.db
        .select({ userId: player.userId, id: player.id })
        .from(player)
        .where(inArray(player.userId, userIds));
      for (const row of rows) {
        result.set(row.userId, row.id);
      }
    } catch (err) {
      logger.warn({ err, userIds }, 'batched player id lookup failed for event enrichment');
    }
    return result;
  }

  async getPlayerKycStatusByUserId(userId: User['id']): Promise<KycStatus | null> {
    const [row] = await this.drizzle.db
      .select({ kycStatus: player.kycStatus })
      .from(player)
      .where(eq(player.userId, userId))
      .limit(1);
    return row?.kycStatus ?? null;
  }

  async getPlayerUserIdsSharingLoginIp(
    userId: User['id'],
    ipAddress: string,
  ): Promise<User['id'][]> {
    const rows = await this.drizzle.db
      .select({ userId: user.id })
      .from(session)
      .innerJoin(user, eq(session.userId, user.id))
      .innerJoin(player, eq(player.userId, user.id))
      .where(and(eq(session.ipAddress, ipAddress), ne(user.id, userId), eq(user.role, 'player')))
      .groupBy(user.id);
    return rows.map((r) => r.userId);
  }

  async canReceiveLoginWithdrawalAlerts(userId: User['id']): Promise<boolean> {
    const [row] = await this.drizzle.db
      .select({ enabled: user.loginWithdrawalAlertsEnabled, emailVerified: user.emailVerified })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    return row?.enabled === true && row.emailVerified === true;
  }
}

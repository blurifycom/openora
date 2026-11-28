import {
  type DrizzleDb,
  type DrizzleTx,
  type EventBus,
  DrizzleService,
  pageToOffset,
  makeNotFoundError,
  makeConflictError,
} from '@openora/core/server';
import { eq, asc, desc, and, or, gt, isNull, count, ilike, sql } from 'drizzle-orm';
import {
  ADMIN_IDLE_MINUTES,
  AUTO_LOGOUT_MINUTES,
  type ClientMeta,
  type IdentityReader,
  type McpTokenRevocation,
  type User,
  type PaginationOptions,
} from '@openora/core/contracts';
import { player } from '@openora/core/pam/schema/profile';
import { session, user, type Session } from '../schema/index.js';
import { type ActiveSessionItem, type SessionItem, type SessionSortBy } from '../contract/index.js';

import { describeDevice } from './device-fingerprint.service.js';

export const SessionNotFoundError = makeNotFoundError('Session');

function idleWindowMinutesCase() {
  return sql.join(
    [
      sql`CASE WHEN ${user.role} = 'player' THEN CASE ${user.autoLogoutDuration}`,
      ...Object.entries(AUTO_LOGOUT_MINUTES).map(
        ([duration, minutes]) => sql`WHEN ${duration} THEN ${minutes}`,
      ),
      sql`END ELSE ${ADMIN_IDLE_MINUTES} END`,
    ],
    sql` `,
  );
}

function notIdledOut() {
  return or(
    isNull(session.lastSeenAt),
    gt(session.lastSeenAt, sql`now() - make_interval(mins => (${idleWindowMinutesCase()})::int)`),
  );
}
export const CurrentSessionRevokeError = makeConflictError(
  'CurrentSessionRevokeError',
  'The current session cannot be revoked - sign out instead',
);

export type SessionServiceDeps = {
  drizzle: DrizzleService;
  events: EventBus;
  identityReader: IdentityReader;
  mcpTokens?: McpTokenRevocation | undefined;
};

function toSessionItem(row: Session, currentSessionId?: Session['id']): SessionItem {
  const { label, browser, os } = describeDevice(row.userAgent);
  return {
    id: row.id,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    deviceLabel: label,
    browser,
    os,
    current: row.id === currentSessionId,
  };
}

export class SessionService {
  private readonly drizzle: DrizzleService;
  private readonly events: EventBus;
  private readonly identityReader: IdentityReader;
  private readonly mcpTokens: McpTokenRevocation | undefined;

  constructor({ drizzle, events, identityReader, mcpTokens }: SessionServiceDeps) {
    this.drizzle = drizzle;
    this.events = events;
    this.identityReader = identityReader;
    this.mcpTokens = mcpTokens;
  }

  async listSessions({
    userId,
    currentSessionId,
    activeOnly,
    page,
    limit,
    sortBy,
    sortOrder,
  }: PaginationOptions<
    { userId: User['id']; currentSessionId?: Session['id']; activeOnly?: boolean },
    SessionSortBy
  >) {
    const where = activeOnly
      ? and(eq(session.userId, userId), gt(session.expiresAt, sql`now()`), notIdledOut())
      : eq(session.userId, userId);
    const db = this.drizzle.db;
    const activeFirst = sql<number>`CASE WHEN ${session.expiresAt} > NOW() THEN 0 ELSE 1 END`;
    const dir = (sortOrder ?? 'desc') === 'asc' ? asc : desc;
    const col =
      sortBy === 'expiresAt'
        ? session.expiresAt
        : sortBy === 'updatedAt'
          ? session.updatedAt
          : session.createdAt;
    const [rows, [{ n }]] = await Promise.all([
      db
        .select({ session })
        .from(session)
        .innerJoin(user, eq(session.userId, user.id))
        .where(where)
        .orderBy(...(sortBy ? [dir(col)] : [activeFirst, dir(col)]))
        .limit(limit)
        .offset(pageToOffset(page, limit)),
      db
        .select({ n: count() })
        .from(session)
        .innerJoin(user, eq(session.userId, user.id))
        .where(where),
    ]);
    return {
      items: rows.map((row) => toSessionItem(row.session, currentSessionId)),
      total: Number(n),
      page,
      limit,
    };
  }

  async listAllActiveSessions({
    role,
    query,
    currentSessionId,
    page,
    limit,
    sortBy,
    sortOrder,
  }: PaginationOptions<
    { role?: string | undefined; query?: string | undefined; currentSessionId?: string },
    SessionSortBy
  >) {
    const db = this.drizzle.db;
    const filters = [gt(session.expiresAt, sql`now()`), notIdledOut()];
    if (role) {
      filters.push(eq(user.role, role));
    }
    if (query) {
      filters.push(ilike(user.email, `%${query}%`));
    }
    const where = and(...filters);
    const dir = (sortOrder ?? 'desc') === 'asc' ? asc : desc;
    const col =
      sortBy === 'expiresAt'
        ? session.expiresAt
        : sortBy === 'updatedAt'
          ? session.updatedAt
          : session.createdAt;

    const [rows, [countRow]] = await Promise.all([
      db
        .select({ session, email: user.email, role: user.role })
        .from(session)
        .innerJoin(user, eq(session.userId, user.id))
        .where(where)
        .orderBy(dir(col))
        .limit(limit)
        .offset(pageToOffset(page, limit)),
      db
        .select({ n: count() })
        .from(session)
        .innerJoin(user, eq(session.userId, user.id))
        .where(where),
    ]);

    return {
      items: rows.map(
        (row): ActiveSessionItem => ({
          ...toSessionItem(row.session, currentSessionId),
          userId: row.session.userId,
          email: row.email,
          role: row.role,
        }),
      ),
      total: Number(countRow?.n ?? 0),
      page,
      limit,
    };
  }

  async revokeOwnSession(
    userId: User['id'],
    id: Session['id'],
    currentSessionId: Session['id'] | undefined,
    meta?: ClientMeta,
  ) {
    if (currentSessionId && id === currentSessionId) {
      throw new CurrentSessionRevokeError();
    }
    return this.revokeSession(userId, id, userId, meta);
  }

  async revokeSession(userId: User['id'], id: string, actorId?: User['id'], meta?: ClientMeta) {
    const updated = await this.drizzle.db
      .update(session)
      .set({ expiresAt: sql`now()`, updatedAt: session.updatedAt })
      .where(and(eq(session.id, id), eq(session.userId, userId)))
      .returning({ id: session.id });

    if (updated.length === 0) {
      throw new SessionNotFoundError(id);
    }

    this.events.emit('identity.session.revoked', {
      userId,
      playerId: await this.identityReader.getPlayerIdByUserIdSafe(userId),
      sessionId: id,
      actorId,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    });
    return { success: true as const };
  }

  async revokeAllSessions(userId: User['id'], actorId?: User['id'], meta?: ClientMeta) {
    const mcpTokens = await this.mcpTokensOf(userId);
    if (mcpTokens) {
      await this.drizzle.db.transaction(async (tx) => {
        await expireActiveSessions(tx, userId);
        await mcpTokens.revokeAllForUser(sessionsRevoked({ userId, actorId, meta }), tx);
      });
    } else {
      await expireActiveSessions(this.drizzle.db, userId);
    }

    this.events.emit('identity.sessions.revoked_all', {
      userId,
      playerId: await this.identityReader.getPlayerIdByUserIdSafe(userId),
      actorId,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    });
    return { success: true as const };
  }

  async revokeAllSessionsIn(tx: DrizzleTx, userId: User['id']): Promise<void> {
    await expireActiveSessions(tx, userId);
    await (
      await this.mcpTokensOf(userId, tx)
    )?.revokeAllForUser(sessionsRevoked({ userId, actorId: undefined, meta: undefined }), tx);
    const [profile] = await tx
      .select({ id: player.id })
      .from(player)
      .where(eq(player.userId, userId))
      .limit(1);
    await this.events.emitInTransaction(tx, 'identity.sessions.revoked_all', {
      userId,
      playerId: profile?.id ?? null,
      ip: null,
      userAgent: null,
    });
  }

  async endSessionsAfterPasswordReset(userId: User['id'], meta?: ClientMeta) {
    const mcpTokens = await this.mcpTokensOf(userId);
    const revocation = sessionsRevoked({ userId, actorId: userId, meta });
    let ended = 0;
    let failure: unknown = null;
    try {
      ended = await this.drizzle.db.transaction(async (tx) => {
        const count = await expireActiveSessions(tx, userId);
        await mcpTokens?.revokeAllForUser(revocation, tx);
        return count;
      });
    } catch (err) {
      try {
        ended = await expireActiveSessions(this.drizzle.db, userId);
      } catch (fallbackErr) {
        throw new AggregateError([err, fallbackErr], 'Password reset could not end the sessions.');
      }
      try {
        await mcpTokens?.revokeAllForUser(revocation);
      } catch (retryErr) {
        failure = new AggregateError(
          [err, retryErr],
          'Password reset could not revoke the MCP tokens.',
        );
      }
    }
    if (ended > 0) {
      this.events.emit('identity.sessions.revoked_all', {
        userId,
        playerId: await this.identityReader.getPlayerIdByUserIdSafe(userId),
        actorId: userId,
        ip: meta?.ip ?? null,
        userAgent: meta?.userAgent ?? null,
      });
    }
    if (failure !== null) {
      throw failure;
    }
  }

  async revokeMcpTokens(userId: User['id'], actorId: User['id'], meta?: ClientMeta) {
    const mcpTokens = await this.mcpTokensOf(userId);
    await mcpTokens?.revokeAllForUser(sessionsRevoked({ userId, actorId, meta }));
  }

  private async mcpTokensOf(userId: User['id'], db: DrizzleDb | DrizzleTx = this.drizzle.db) {
    if (!this.mcpTokens) {
      return undefined;
    }
    const [account] = await db.select({ role: user.role }).from(user).where(eq(user.id, userId));
    return account?.role === 'player' ? undefined : this.mcpTokens;
  }
}

export async function expireActiveSessions(
  db: DrizzleDb | DrizzleTx,
  userId: User['id'],
): Promise<number> {
  const ended = await db
    .update(session)
    .set({ expiresAt: sql`now()`, updatedAt: session.updatedAt })
    .where(and(eq(session.userId, userId), gt(session.expiresAt, sql`now()`)))
    .returning({ id: session.id });
  return ended.length;
}

function sessionsRevoked({
  userId,
  actorId,
  meta,
}: {
  userId: User['id'];
  actorId: User['id'] | undefined;
  meta: ClientMeta | undefined;
}) {
  return {
    userId,
    reason: 'sessions_revoked' as const,
    actorId: actorId ?? null,
    ip: meta?.ip ?? null,
    userAgent: meta?.userAgent ?? null,
  };
}

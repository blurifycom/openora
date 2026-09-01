import {
  type EventBus,
  DrizzleService,
  pageToOffset,
  makeNotFoundError,
  makeConflictError,
} from '@openora/core/server';
import { eq, asc, desc, and, gt, count, ilike, sql } from 'drizzle-orm';
import type { ClientMeta, IdentityReader, User, PaginationOptions } from '@openora/core/contracts';
import { session, user, type Session } from '../schema/index.js';
import { type ActiveSessionItem, type SessionItem, type SessionSortBy } from '../contract/index.js';

import { describeDevice } from './device-fingerprint.service.js';

export const SessionNotFoundError = makeNotFoundError('Session');
export const CurrentSessionRevokeError = makeConflictError(
  'CurrentSessionRevokeError',
  'The current session cannot be revoked - sign out instead',
);

export type SessionServiceDeps = {
  drizzle: DrizzleService;
  events: EventBus;
  identityReader: IdentityReader;
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

  constructor({ drizzle, events, identityReader }: SessionServiceDeps) {
    this.drizzle = drizzle;
    this.events = events;
    this.identityReader = identityReader;
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
      ? and(eq(session.userId, userId), gt(session.expiresAt, sql`now()`))
      : eq(session.userId, userId);
    const db = this.drizzle.db;
    // Active sessions first (expiresAt > now), then user-chosen sort within each group.
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
        .select()
        .from(session)
        .where(where)
        .orderBy(...(sortBy ? [dir(col)] : [activeFirst, dir(col)]))
        .limit(limit)
        .offset(pageToOffset(page, limit)),
      db.select({ n: count() }).from(session).where(where),
    ]);
    return {
      items: rows.map((s) => toSessionItem(s, currentSessionId)),
      total: Number(n),
      page,
      limit,
    };
  }

  /**
   * Every active session on the platform, newest first, with the account each belongs
   * to. `listSessions` needs a userId and so cannot answer "who is logged in right now",
   * which is what a Super Admin needs before revoking someone else's session.
   */
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
    const filters = [gt(session.expiresAt, sql`now()`)];
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

  /**
   * Self-service revoke. Refuses the caller's own session: ending it here would look
   * like a silent logout rather than the deliberate "sign out" action, and the session
   * list marks it as current precisely so it is not the one you cut off.
   */
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
      // Keep updatedAt as-is: it is the session's last-used time in the device
      // list, and the $onUpdateFn would otherwise overwrite it with the revoke time.
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
    await this.drizzle.db
      .update(session)
      .set({ expiresAt: sql`now()`, updatedAt: session.updatedAt })
      .where(and(eq(session.userId, userId), gt(session.expiresAt, sql`now()`)));

    this.events.emit('identity.sessions.revoked_all', {
      userId,
      playerId: await this.identityReader.getPlayerIdByUserIdSafe(userId),
      actorId,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    });
    return { success: true as const };
  }
}

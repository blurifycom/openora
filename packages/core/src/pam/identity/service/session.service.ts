import {
  type EventBus,
  DrizzleService,
  pageToOffset,
  makeNotFoundError,
} from '@openora/core/server';
import { eq, asc, desc, and, gt, count, sql } from 'drizzle-orm';
import type { ClientMeta, IdentityReader, User, PaginationOptions } from '@openora/core/contracts';
import { session } from '../schema/index.js';
import { type SessionItem, type SessionSortBy } from '../contract/index.js';

export const SessionNotFoundError = makeNotFoundError('Session');

export type SessionServiceDeps = {
  drizzle: DrizzleService;
  events: EventBus;
  identityReader: IdentityReader;
};

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
    { userId: User['id']; currentSessionId?: string; activeOnly?: boolean },
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
      items: rows.map(
        (s): SessionItem => ({
          id: s.id,
          expiresAt: s.expiresAt.toISOString(),
          createdAt: s.createdAt.toISOString(),
          updatedAt: s.updatedAt.toISOString(),
          ipAddress: s.ipAddress,
          userAgent: s.userAgent,
          current: s.id === currentSessionId,
        }),
      ),
      total: Number(n),
      page,
      limit,
    };
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

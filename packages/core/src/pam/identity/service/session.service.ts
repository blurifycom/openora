import {
  type EventBus,
  DrizzleService,
  pageToOffset,
  makeNotFoundError,
} from '@openora/core/server';
import { eq, asc, desc, and, gt, count, sql } from 'drizzle-orm';
import type { User } from '@openora/core/contracts';
import { session } from '../schema/index.js';
import { type SessionItem } from '../contract/index.js';

export const SessionNotFoundError = makeNotFoundError('Session');

export type SessionServiceDeps = {
  drizzle: DrizzleService;
  events: EventBus;
};

export class SessionService {
  private readonly drizzle: DrizzleService;
  private readonly events: EventBus;

  constructor({ drizzle, events }: SessionServiceDeps) {
    this.drizzle = drizzle;
    this.events = events;
  }

  async listSessions({
    userId,
    page,
    limit,
    sortBy,
    sortOrder,
  }: {
    userId: User['id'];
    page: number;
    limit: number;
    sortBy?: string;
    sortOrder?: string;
  }) {
    const where = eq(session.userId, userId);
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
        .orderBy(activeFirst, dir(col))
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
          ipAddress: s.ipAddress,
          userAgent: s.userAgent,
        }),
      ),
      total: Number(n),
      page,
      limit,
    };
  }

  async revokeSession(userId: User['id'], id: string, actorId?: User['id']) {
    const updated = await this.drizzle.db
      .update(session)
      .set({ expiresAt: sql`now()` })
      .where(and(eq(session.id, id), eq(session.userId, userId)))
      .returning({ id: session.id });

    if (updated.length === 0) {
      throw new SessionNotFoundError(id);
    }

    this.events.emit('identity.session.revoked', {
      userId: userId,
      sessionId: id,
      actorId,
    });
    return { success: true as const };
  }

  async revokeAllSessions(userId: User['id'], actorId?: User['id']) {
    await this.drizzle.db
      .update(session)
      .set({ expiresAt: sql`now()` })
      .where(and(eq(session.userId, userId), gt(session.expiresAt, sql`now()`)));

    this.events.emit('identity.sessions.revoked_all', { userId: userId, actorId });
    return { success: true as const };
  }
}

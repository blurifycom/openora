import { ORPCError } from '@orpc/server';
import { type EventBus, DrizzleService, pageToOffset } from '@blurifycom/core/server';
import { eq, desc, and, gt, count, sql } from 'drizzle-orm';
import { session } from '../schema/index.js';
import { type SessionItem } from '../contract/index.js';

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

  async listSessions(userId: string, page: number, limit: number) {
    const where = eq(session.userId, userId);
    const db = this.drizzle.db;
    // Active sessions first (expiresAt > now), newest-first within each group.
    const activeFirst = sql<number>`CASE WHEN ${session.expiresAt} > NOW() THEN 0 ELSE 1 END`;
    const [rows, [{ n }]] = await Promise.all([
      db
        .select()
        .from(session)
        .where(where)
        .orderBy(activeFirst, desc(session.createdAt))
        .limit(limit)
        .offset(pageToOffset(page, limit)),
      db.select({ n: count() }).from(session).where(where),
    ]);
    return {
      items: rows.map(
        (s): SessionItem => ({
          id: s.id,
          token: s.token,
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

  async revokeSession(userId: string, token: string) {
    const now = new Date();
    const updated = await this.drizzle.db
      .update(session)
      .set({ expiresAt: now })
      .where(and(eq(session.token, token), eq(session.userId, userId)))
      .returning({ id: session.id });

    if (updated.length === 0) {
      throw new ORPCError('NOT_FOUND', { message: 'Session not found' });
    }

    this.events.emit('identity.session.revoked', { userId: userId, sessionToken: token });
    return { success: true as const };
  }

  async revokeAllSessions(userId: string) {
    const now = new Date();
    await this.drizzle.db
      .update(session)
      .set({ expiresAt: now })
      .where(and(eq(session.userId, userId), gt(session.expiresAt, now)));

    this.events.emit('identity.sessions.revoked_all', { userId: userId });
    return { success: true as const };
  }
}

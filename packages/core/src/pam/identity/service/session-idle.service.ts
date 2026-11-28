import { type EventBus, DrizzleService, createLogger } from '@openora/core/server';
import { and, eq, gt, sql } from 'drizzle-orm';
import {
  ADMIN_IDLE_MINUTES,
  AUTO_LOGOUT_MINUTES,
  type IdentityReader,
  type SessionIdlePolicy,
  type User,
} from '@openora/core/contracts';
import { session, user, type Session } from '../schema/index.js';

const logger = createLogger('session-idle');

const LAST_SEEN_THROTTLE_MS = 60 * 1000;

export type SessionIdleServiceDeps = {
  drizzle: DrizzleService;
  events: EventBus;
  identityReader: IdentityReader;
};

export class SessionIdleService implements SessionIdlePolicy {
  private readonly drizzle: DrizzleService;
  private readonly events: EventBus;
  private readonly identityReader: IdentityReader;

  constructor({ drizzle, events, identityReader }: SessionIdleServiceDeps) {
    this.drizzle = drizzle;
    this.events = events;
    this.identityReader = identityReader;
  }

  async touch(
    userId: User['id'],
    sessionId: Session['id'],
  ): Promise<'active' | 'expired' | 'idle'> {
    const [row] = await this.drizzle.db
      .select({
        lastSeenAt: session.lastSeenAt,
        autoLogoutDuration: user.autoLogoutDuration,
        role: user.role,
      })
      .from(session)
      .innerJoin(user, eq(user.id, session.userId))
      .where(and(eq(session.id, sessionId), eq(session.userId, userId)))
      .limit(1);
    if (!row) {
      return 'expired';
    }

    let windowMinutes: number | undefined = ADMIN_IDLE_MINUTES;
    if (row.role === 'player') {
      windowMinutes = AUTO_LOGOUT_MINUTES[row.autoLogoutDuration];
    }
    if (windowMinutes === undefined) {
      logger.error(
        { userId, sessionId, duration: row.autoLogoutDuration },
        'unknown auto-logout duration',
      );
      await this.expire(userId, sessionId);
      return 'expired';
    }
    const windowMs = windowMinutes * 60_000;
    const idleForMs = row.lastSeenAt ? Date.now() - row.lastSeenAt.getTime() : null;

    if (idleForMs !== null && idleForMs > windowMs) {
      await this.expire(userId, sessionId);
      return 'idle';
    }

    if (idleForMs === null || idleForMs >= LAST_SEEN_THROTTLE_MS) {
      await this.drizzle.db
        .update(session)
        .set({ lastSeenAt: sql`now()` })
        .where(eq(session.id, sessionId));
    }
    return 'active';
  }

  private async expire(userId: User['id'], sessionId: Session['id']): Promise<void> {
    const updated = await this.drizzle.db
      .update(session)
      .set({ expiresAt: sql`now()`, updatedAt: session.updatedAt })
      .where(and(eq(session.id, sessionId), gt(session.expiresAt, sql`now()`)))
      .returning({ id: session.id });
    if (updated.length === 0) {
      return;
    }

    this.events.emit('identity.session.revoked', {
      userId,
      playerId: await this.identityReader.getPlayerIdByUserIdSafe(userId),
      sessionId,
      ip: null,
      userAgent: null,
    });
  }
}

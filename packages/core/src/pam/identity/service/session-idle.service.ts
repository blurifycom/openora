import { type EventBus, DrizzleService } from '@openora/core/server';
import { and, eq, sql } from 'drizzle-orm';
import {
  AUTO_LOGOUT_MINUTES,
  type IdentityReader,
  type SessionIdlePolicy,
  type User,
} from '@openora/core/contracts';
import { session, user, type Session } from '../schema/index.js';

// Tighter than the admin guard's 5 minutes: `lastSeenAt` is the input to the idle
// comparison here, not just a display value, and a 5-minute lag would stretch the
// shortest window (15 minutes) by a third before it bites.
const LAST_SEEN_THROTTLE_MS = 60 * 1000;

export type SessionIdleServiceDeps = {
  drizzle: DrizzleService;
  events: EventBus;
  identityReader: IdentityReader;
};

/**
 * Enforces the player's "Auto-logout when inactive" choice. Runs on every authenticated
 * request, so it does the cheapest thing that works: one joined read, and a write only
 * when the throttle has lapsed or the session has to go.
 */
export class SessionIdleService implements SessionIdlePolicy {
  private readonly drizzle: DrizzleService;
  private readonly events: EventBus;
  private readonly identityReader: IdentityReader;

  constructor({ drizzle, events, identityReader }: SessionIdleServiceDeps) {
    this.drizzle = drizzle;
    this.events = events;
    this.identityReader = identityReader;
  }

  async touch(userId: User['id'], sessionId: Session['id']): Promise<'active' | 'expired'> {
    const [row] = await this.drizzle.db
      .select({
        lastSeenAt: session.lastSeenAt,
        autoLogoutDuration: user.autoLogoutDuration,
      })
      .from(session)
      .innerJoin(user, eq(user.id, session.userId))
      .where(and(eq(session.id, sessionId), eq(session.userId, userId)))
      .limit(1);
    if (!row) {
      return 'active';
    }

    const windowMs = AUTO_LOGOUT_MINUTES[row.autoLogoutDuration] * 60_000;
    const idleForMs = row.lastSeenAt ? Date.now() - row.lastSeenAt.getTime() : null;

    // `idleForMs === null` means the session predates this column and has no activity on
    // record yet. It falls through to the stamp below on purpose: reading that null as
    // "idle since the beginning of time" would cut every standing session on deploy.
    if (idleForMs !== null && idleForMs > windowMs) {
      await this.expire(userId, sessionId);
      return 'expired';
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
    await this.drizzle.db
      .update(session)
      // Same shape as an explicit revoke: expire in place and leave `updatedAt` alone, so
      // the device list still shows when the session was last actually used.
      .set({ expiresAt: sql`now()`, updatedAt: session.updatedAt })
      .where(eq(session.id, sessionId));

    // No `actorId`: nobody revoked this, the player's own inactivity window did.
    this.events.emit('identity.session.revoked', {
      userId,
      playerId: await this.identityReader.getPlayerIdByUserIdSafe(userId),
      sessionId,
      ip: null,
      userAgent: null,
    });
  }
}

import { type EventBus, DrizzleService, createLogger } from '@openora/core/server';
import { and, eq, gt, sql } from 'drizzle-orm';
import {
  AUTO_LOGOUT_MINUTES,
  type IdentityReader,
  type SessionIdlePolicy,
  type User,
} from '@openora/core/contracts';
import { session, user, type Session } from '../schema/index.js';

const logger = createLogger('session-idle');

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
        role: user.role,
      })
      .from(session)
      .innerJoin(user, eq(user.id, session.userId))
      .where(and(eq(session.id, sessionId), eq(session.userId, userId)))
      .limit(1);
    // No row: the session was revoked (or never existed) between better-auth resolving it
    // and this query running. Reporting 'active' here would publish a session onto the
    // context that this very read could not find - fail closed instead, the same as an
    // over-idle window.
    if (!row) {
      return 'expired';
    }

    // The setting is player-only - `assertPlayerPreferenceCaller` never lets an admin set
    // it, so every admin row is stuck at the column default. Admin sessions already have
    // their own idle tracking through `AdminGuard`/`AdminSecurityService.touchLastSeen`;
    // enforcing a second, un-configurable mechanism here would idle out backoffice staff
    // on a window they have no way to see or change.
    if (row.role !== 'player') {
      return 'active';
    }

    const windowMinutes = AUTO_LOGOUT_MINUTES[row.autoLogoutDuration];
    if (windowMinutes === undefined) {
      // Only reachable if the enum and this map ever disagree (a bad migration or a
      // partial deploy). Failing open on a security control has no visible symptom, so
      // this must not silently return 'active' the way a missing map entry otherwise would.
      logger.error(
        { userId, sessionId, duration: row.autoLogoutDuration },
        'unknown auto-logout duration',
      );
      await this.expire(userId, sessionId);
      return 'expired';
    }
    const windowMs = windowMinutes * 60_000;
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
    // Conditional on `expiresAt > now()` plus a `.returning()` check, exactly like
    // `revokeSession` (session.service.ts) - without it, concurrent requests past the
    // same stale `lastSeenAt` each pass the idle test, each write, and each emit
    // `identity.session.revoked` into the append-only audit chain for one logout.
    const updated = await this.drizzle.db
      .update(session)
      // Same shape as an explicit revoke: expire in place and leave `updatedAt` alone, so
      // the device list still shows when the session was last actually used.
      .set({ expiresAt: sql`now()`, updatedAt: session.updatedAt })
      .where(and(eq(session.id, sessionId), gt(session.expiresAt, sql`now()`)))
      .returning({ id: session.id });
    if (updated.length === 0) {
      return;
    }

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

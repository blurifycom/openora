import { type EventBus, DrizzleService } from '@openora/core/server';
import { eq, sql } from 'drizzle-orm';
import type {
  AdminSecurityConfig,
  ClientMeta,
  IdentityReader,
  TwoFactorChallengeMethod,
  User,
} from '@openora/core/contracts';
import { user, verification } from '../schema/index.js';
import {
  computeLockoutTier,
  createAccountLockedError,
  isActiveLockout,
} from './lockout-policy.service.js';

// better-auth withholds the session until the second factor clears, so a failing
// attempt has no session to identify. It does store the pending user id in a
// verification row keyed by the identifier it puts in the signed two-factor cookie
// (`2fa-<random>`), which is what lets the lockout follow the account rather than
// only the browser. Cookie value is `<identifier>.<signature>`.
const PENDING_2FA_IDENTIFIER_PREFIX = '2fa-';

function pendingIdentifier(cookieValue: string | undefined): string | undefined {
  if (!cookieValue) {
    return undefined;
  }
  const [identifier = ''] = cookieValue.split('.');
  return identifier.startsWith(PENDING_2FA_IDENTIFIER_PREFIX) ? identifier : undefined;
}

export type TwoFactorLockoutServiceDeps = {
  drizzle: DrizzleService;
  events: EventBus;
  identityReader: IdentityReader;
  config: AdminSecurityConfig['twoFactorLockout'];
};

/**
 * Consecutive-failure lockout for the second factor, counted per account and kept in
 * columns of its own: a second-factor lockout must not consume the password-login
 * budget, and the two thresholds are configured independently.
 */
export class TwoFactorLockoutService {
  private readonly drizzle: DrizzleService;
  private readonly events: EventBus;
  private readonly identityReader: IdentityReader;
  private readonly config: AdminSecurityConfig['twoFactorLockout'];

  constructor({ drizzle, events, identityReader, config }: TwoFactorLockoutServiceDeps) {
    this.drizzle = drizzle;
    this.events = events;
    this.identityReader = identityReader;
    this.config = config;
  }

  async resolvePendingUserId(cookieValue: string | undefined): Promise<User['id'] | undefined> {
    const identifier = pendingIdentifier(cookieValue);
    if (!identifier) {
      return undefined;
    }
    const [row] = await this.drizzle.db
      .select({ value: verification.value })
      .from(verification)
      .where(eq(verification.identifier, identifier))
      .limit(1);
    return row?.value;
  }

  async assertNotLocked(userId: User['id']): Promise<void> {
    const [row] = await this.drizzle.db
      .select({ lockoutUntil: user.twoFactorLockoutUntil })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);

    if (isActiveLockout(row?.lockoutUntil)) {
      throw createAccountLockedError(row?.lockoutUntil ?? new Date());
    }
  }

  /**
   * `method` is the credential that was presented, so the audit trail can tell a wrong
   * recovery code from a wrong authenticator code. Throws the account-locked error when this
   * failure trips the lockout.
   */
  async recordFailure(
    userId: User['id'],
    method: TwoFactorChallengeMethod,
    meta: ClientMeta,
  ): Promise<void> {
    const { lockoutUntil } = await this.countFailure(userId, method, meta);
    if (lockoutUntil) {
      throw createAccountLockedError(lockoutUntil);
    }
  }

  /**
   * `recordFailure` for a caller that answers the lockout itself instead of throwing. Counts
   * under the account row's lock, so overlapping wrong codes are each counted; one that lands
   * after another has locked the account answers that lock without extending it.
   */
  async countFailure(
    userId: User['id'],
    method: TwoFactorChallengeMethod,
    meta: ClientMeta,
  ): Promise<{ attemptsRemaining: number | undefined; lockoutUntil: Date | null }> {
    const counted = await this.drizzle.db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          failedAttempts: user.failedTwoFactorAttempts,
          lockoutCount: user.twoFactorLockoutCount,
          lastFailedAt: user.lastFailedTwoFactorAt,
          lockoutUntil: user.twoFactorLockoutUntil,
        })
        .from(user)
        .where(eq(user.id, userId))
        .for('update')
        .limit(1);

      if (!row) {
        return null;
      }
      if (row.lockoutUntil && isActiveLockout(row.lockoutUntil)) {
        return { attemptsRemaining: 0, lockoutUntil: row.lockoutUntil, locking: false };
      }

      const attempts = row.failedAttempts + 1;
      const isLocking = attempts >= this.config.maxAttempts;
      const { durationMs } = computeLockoutTier({
        lockoutCount: row.lockoutCount,
        lastFailedLoginAt: row.lastFailedAt,
        nowMs: Date.now(),
        fallbackDurationMs: this.config.durationMs,
      });
      const lockoutUntil = isLocking ? new Date(Date.now() + durationMs) : null;

      await tx
        .update(user)
        .set({
          failedTwoFactorAttempts: isLocking ? 0 : attempts,
          lastFailedTwoFactorAt: sql`now()`,
          ...(isLocking
            ? {
                twoFactorLockoutUntil: lockoutUntil,
                twoFactorLockoutCount: row.lockoutCount + 1,
              }
            : {}),
        })
        .where(eq(user.id, userId));

      return {
        attemptsRemaining: isLocking ? 0 : Math.max(this.config.maxAttempts - attempts, 0),
        lockoutUntil,
        locking: isLocking,
      };
    });

    if (!counted) {
      return { attemptsRemaining: undefined, lockoutUntil: null };
    }
    const { attemptsRemaining, lockoutUntil, locking } = counted;
    const playerId = await this.identityReader.getPlayerIdByUserIdSafe(userId);
    this.events.emit('identity.2fa.failed', {
      userId,
      playerId,
      method,
      attemptsRemaining,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    });

    if (locking && lockoutUntil) {
      this.events.emit('identity.2fa.lockout.triggered', {
        userId,
        playerId,
        lockoutUntil: lockoutUntil.toISOString(),
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
      });
    }
    return { attemptsRemaining, lockoutUntil };
  }

  async reset(userId: User['id']): Promise<void> {
    await this.drizzle.db
      .update(user)
      .set({
        failedTwoFactorAttempts: 0,
        twoFactorLockoutUntil: null,
        lastFailedTwoFactorAt: null,
      })
      .where(eq(user.id, userId));
  }
}

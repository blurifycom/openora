import { timingSafeEqual } from 'node:crypto';
import { ORPCError } from '@orpc/server';
import { eq } from 'drizzle-orm';
import {
  type Auth,
  type EventBus,
  type DrizzleService,
  type NodeHeaders,
  assertRateLimit,
  createLogger,
} from '@openora/core/server';
import {
  RATE_LIMIT_KEYS,
  makeRateLimitKey,
  type ClientMeta,
  type IdentityReader,
  type MailDispatchPort,
  type RateLimiterAdapter,
  type RemoveWithdrawalPinInput,
  type SecurityControls,
  type SetWithdrawalPinInput,
  type User,
  type WithdrawalPinVerdict,
  type WithdrawalSecurity,
} from '@openora/core/contracts';
import { user } from '../schema/index.js';
import { getSecurityControls } from './security-controls.service.js';
import { assertFreshReauthentication } from './fresh-reauthentication.service.js';
import { hashWithdrawalPin } from './withdrawal-pin-hash.service.js';
import type { TwoFactorLockoutService } from './two-factor-lockout.service.js';
import { nodeHeadersToHeaders } from '../../shared/headers-mapper.js';

const logger = createLogger('withdrawal-pin');

// Constant-time, though both sides are HMACs under a server secret.
const pinMatches = (candidate: string, stored: string): boolean =>
  candidate.length === stored.length &&
  timingSafeEqual(Buffer.from(candidate), Buffer.from(stored));

const MINUTE_MS = 60 * 1000;
// Five wrong PINs in a row lock withdrawals for half an hour. Fixed, not configurable: the
// mail the player gets states the same 30 minutes, and a PIN is only 10,000 guesses wide.
const WITHDRAWAL_PIN_MAX_FAILED_ATTEMPTS = 5;
const WITHDRAWAL_PIN_LOCK_MS = 30 * MINUTE_MS;
const WITHDRAWAL_PIN_RATE_LIMIT = {
  limit: 5,
  windowMs: 5 * MINUTE_MS,
  onUnavailable: 'deny',
} as const;

const WITHDRAWAL_ADDRESS_REAUTH_RATE_LIMIT = {
  limit: 10,
  windowMs: 5 * MINUTE_MS,
  onUnavailable: 'deny',
} as const;

export type WithdrawalPinServiceDeps = {
  drizzle: DrizzleService;
  events: EventBus;
  limiter: RateLimiterAdapter;
  auth: Auth;
  identityReader: IdentityReader;
  twoFactorLockout?: TwoFactorLockoutService;
  mailDispatch?: MailDispatchPort | undefined;
  hmacSecret: string;
  trustedDeviceDays: number;
};

/**
 * Withdrawal PIN as a security control, independent of the login credential. Set, Change and
 * Remove all ask for fresh reauthentication; `verifyPin` is the half the wallet calls on every
 * withdrawal, through the `WITHDRAWAL_SECURITY` port.
 */
export class WithdrawalPinService implements WithdrawalSecurity {
  private readonly drizzle: DrizzleService;
  private readonly events: EventBus;
  private readonly limiter: RateLimiterAdapter;
  private readonly auth: Auth;
  private readonly identityReader: IdentityReader;
  private readonly twoFactorLockout?: TwoFactorLockoutService;
  private readonly mailDispatch?: MailDispatchPort | undefined;
  private readonly hmacSecret: string;
  private readonly trustedDeviceDays: number;

  constructor({
    drizzle,
    events,
    limiter,
    auth,
    identityReader,
    twoFactorLockout,
    mailDispatch,
    hmacSecret,
    trustedDeviceDays,
  }: WithdrawalPinServiceDeps) {
    this.drizzle = drizzle;
    this.events = events;
    this.limiter = limiter;
    this.auth = auth;
    this.identityReader = identityReader;
    this.twoFactorLockout = twoFactorLockout;
    this.mailDispatch = mailDispatch;
    this.hmacSecret = hmacSecret;
    this.trustedDeviceDays = trustedDeviceDays;
  }

  private async securityControlsFor(userId: User['id']): Promise<SecurityControls> {
    const controls = await getSecurityControls(this.drizzle, userId, this.trustedDeviceDays);
    if (!controls) {
      throw new ORPCError('UNAUTHORIZED', { message: 'Not signed in.' });
    }
    return controls;
  }

  private async loadCaller(userId: User['id']) {
    const [caller] = await this.drizzle.db
      .select({
        role: user.role,
        twoFactorEnabled: user.twoFactorEnabled,
        withdrawalPinHash: user.withdrawalPinHash,
      })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    if (!caller) {
      throw new ORPCError('UNAUTHORIZED', { message: 'Not signed in.' });
    }
    return caller;
  }

  private async assertPlayer(
    userId: User['id'],
    role: string,
    action: 'set' | 'remove',
    meta: ClientMeta,
  ) {
    if (role === 'player') {
      return;
    }
    // A service-level denial still owes the audit log the same signal AdminGuard emits,
    // since this check rejects before any shared guard runs (docs/standards/audit.md).
    this.events.emit('identity.user.unauthorized_access', {
      userId,
      playerId: null,
      resource: 'identity.security.withdrawal_pin',
      action,
      role,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    throw new ORPCError('FORBIDDEN', { message: 'Only players can manage a withdrawal PIN.' });
  }

  async set(
    userId: User['id'],
    input: SetWithdrawalPinInput,
    reqHeaders: NodeHeaders,
    meta: ClientMeta,
  ): Promise<SecurityControls> {
    await assertRateLimit(
      this.limiter,
      makeRateLimitKey(RATE_LIMIT_KEYS.WITHDRAWAL_PIN_MUTATION, userId),
      WITHDRAWAL_PIN_RATE_LIMIT,
    );
    const caller = await this.loadCaller(userId);
    await this.assertPlayer(userId, caller.role, 'set', meta);
    await assertFreshReauthentication({
      drizzle: this.drizzle,
      auth: this.auth,
      twoFactorLockout: this.twoFactorLockout,
      userId,
      headers: nodeHeadersToHeaders(reqHeaders),
      currentPassword: input.currentPassword,
      totpCode: input.totpCode,
      twoFactorEnabled: caller.twoFactorEnabled ?? false,
      meta,
    });

    const wasAlreadySet = caller.withdrawalPinHash !== null;
    await this.drizzle.db
      .update(user)
      .set({
        withdrawalPinHash: hashWithdrawalPin(input.pin, this.hmacSecret),
        withdrawalPinSetAt: new Date(),
        withdrawalPinFailedAttempts: 0,
      })
      .where(eq(user.id, userId));
    this.events.emit('identity.security.withdrawal_pin.set', {
      userId,
      playerId: await this.identityReader.getPlayerIdByUserIdSafe(userId),
      wasAlreadySet,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return this.securityControlsFor(userId);
  }

  async remove(
    userId: User['id'],
    input: RemoveWithdrawalPinInput,
    reqHeaders: NodeHeaders,
    meta: ClientMeta,
  ): Promise<SecurityControls> {
    await assertRateLimit(
      this.limiter,
      makeRateLimitKey(RATE_LIMIT_KEYS.WITHDRAWAL_PIN_MUTATION, userId),
      WITHDRAWAL_PIN_RATE_LIMIT,
    );
    const caller = await this.loadCaller(userId);
    await this.assertPlayer(userId, caller.role, 'remove', meta);
    // Before the "no PIN set" shortcut, so the answer does not depend on whether a PIN exists.
    await assertFreshReauthentication({
      drizzle: this.drizzle,
      auth: this.auth,
      twoFactorLockout: this.twoFactorLockout,
      userId,
      headers: nodeHeadersToHeaders(reqHeaders),
      currentPassword: input.currentPassword,
      totpCode: input.totpCode,
      twoFactorEnabled: caller.twoFactorEnabled ?? false,
      meta,
    });

    if (caller.withdrawalPinHash === null) {
      return this.securityControlsFor(userId);
    }
    await this.drizzle.db
      .update(user)
      .set({
        withdrawalPinHash: null,
        withdrawalPinSetAt: null,
        withdrawalPinFailedAttempts: 0,
      })
      .where(eq(user.id, userId));
    this.events.emit('identity.security.withdrawal_pin.removed', {
      userId,
      playerId: await this.identityReader.getPlayerIdByUserIdSafe(userId),
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return this.securityControlsFor(userId);
  }

  async assertReauthentication({
    userId,
    headers,
    currentPassword,
    totpCode,
    meta,
  }: Parameters<WithdrawalSecurity['assertReauthentication']>[0]): Promise<void> {
    // The password is checked here with nothing else in front of it, so without a budget a
    // stolen session could guess it through the address route.
    await assertRateLimit(
      this.limiter,
      makeRateLimitKey(RATE_LIMIT_KEYS.WITHDRAWAL_ADDRESS_REAUTH, userId),
      WITHDRAWAL_ADDRESS_REAUTH_RATE_LIMIT,
    );
    const caller = await this.loadCaller(userId);
    await assertFreshReauthentication({
      drizzle: this.drizzle,
      auth: this.auth,
      twoFactorLockout: this.twoFactorLockout,
      userId,
      headers: nodeHeadersToHeaders(headers),
      currentPassword,
      totpCode,
      twoFactorEnabled: caller.twoFactorEnabled ?? false,
      meta,
    });
  }

  /**
   * Reads, compares and counts under a row lock on the user, so a burst of parallel guesses is
   * judged one at a time: each sees the lock the one before it set, and none can be evaluated
   * after the fifth wrong one has tripped it. The mail and the event go out after the commit.
   */
  async verifyPin({
    userId,
    pin,
    meta,
  }: Parameters<WithdrawalSecurity['verifyPin']>[0]): Promise<WithdrawalPinVerdict> {
    const { verdict, justLocked } = await this.drizzle.db.transaction(async (txn) => {
      const settle = (v: WithdrawalPinVerdict, locked = false) => ({
        verdict: v,
        justLocked: locked,
      });
      const [row] = await txn
        .select({
          hash: user.withdrawalPinHash,
          attempts: user.withdrawalPinFailedAttempts,
          lockedUntil: user.withdrawalPinLockedUntil,
        })
        .from(user)
        .where(eq(user.id, userId))
        .for('update')
        .limit(1);
      if (!row) {
        return settle({ status: 'not_set' });
      }
      // Before the comparison and before the no-PIN shortcut: a right guess must not lift a lock
      // a wrong one set, and removing the PIN must not either.
      if (row.lockedUntil && row.lockedUntil.getTime() > Date.now()) {
        return settle({ status: 'locked', lockedUntil: row.lockedUntil });
      }
      if (row.hash === null) {
        return settle({ status: 'not_set' });
      }
      // Withdrawing without a PIN is not a guess; it is a client that never asked for one.
      if (pin === undefined) {
        return settle({ status: 'missing' });
      }
      if (pinMatches(hashWithdrawalPin(pin, this.hmacSecret), row.hash)) {
        if (row.attempts !== 0) {
          await txn.update(user).set({ withdrawalPinFailedAttempts: 0 }).where(eq(user.id, userId));
        }
        return settle({ status: 'ok' });
      }
      const attempts = row.attempts + 1;
      if (attempts < WITHDRAWAL_PIN_MAX_FAILED_ATTEMPTS) {
        await txn
          .update(user)
          .set({ withdrawalPinFailedAttempts: attempts })
          .where(eq(user.id, userId));
        return settle({
          status: 'incorrect',
          attemptsLeft: WITHDRAWAL_PIN_MAX_FAILED_ATTEMPTS - attempts,
        });
      }
      const lockedUntil = new Date(Date.now() + WITHDRAWAL_PIN_LOCK_MS);
      await txn
        .update(user)
        .set({ withdrawalPinFailedAttempts: 0, withdrawalPinLockedUntil: lockedUntil })
        .where(eq(user.id, userId));
      return settle({ status: 'locked', lockedUntil }, true);
    });
    if (justLocked && verdict.status === 'locked') {
      await this.announceLock(userId, verdict.lockedUntil, meta);
    }
    return verdict;
  }

  private async announceLock(
    userId: User['id'],
    lockedUntil: Date,
    meta: Partial<ClientMeta> | undefined,
  ): Promise<void> {
    this.events.emit('identity.security.withdrawal_pin.locked', {
      userId,
      playerId: await this.identityReader.getPlayerIdByUserIdSafe(userId),
      lockedUntil: lockedUntil.toISOString(),
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    });
    // The lock has committed, so a failed enqueue must not turn the refusal into an error.
    // Keyed on the lock's end, so retries of one lock mail once and the next lock mails again.
    try {
      await this.mailDispatch?.toUser({
        userId,
        template: { key: 'withdrawalsLocked', data: { occurredAt: new Date().toISOString() } },
        idempotencyKey: `withdrawal-pin-locked:${userId}:${lockedUntil.getTime()}`,
      });
    } catch (err) {
      logger.error({ err, userId }, 'withdrawal lock notice enqueue failed');
    }
  }
}

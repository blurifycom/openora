import { ORPCError } from '@orpc/server';
import { eq, sql } from 'drizzle-orm';
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

const MINUTE_MS = 60 * 1000;
// Five wrong PINs in a row lock withdrawals for half an hour. Fixed, not configurable: the
// mail the player gets states the same 30 minutes, and a PIN is only 10,000 guesses wide.
export const WITHDRAWAL_PIN_MAX_FAILED_ATTEMPTS = 5;
export const WITHDRAWAL_PIN_LOCK_MS = 30 * MINUTE_MS;
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
        withdrawalPinLockedUntil: null,
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

  async verifyPin({
    userId,
    pin,
    meta,
  }: Parameters<WithdrawalSecurity['verifyPin']>[0]): Promise<WithdrawalPinVerdict> {
    const [row] = await this.drizzle.db
      .select({
        hash: user.withdrawalPinHash,
        lockedUntil: user.withdrawalPinLockedUntil,
      })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    if (!row || row.hash === null) {
      return { status: 'not_set' };
    }
    // Before the comparison: a right guess must not lift a lock a wrong one set.
    if (row.lockedUntil && row.lockedUntil.getTime() > Date.now()) {
      return { status: 'locked', lockedUntil: row.lockedUntil };
    }
    // Withdrawing without a PIN is not a guess; it is a client that never asked for one.
    if (pin === undefined) {
      return { status: 'missing' };
    }
    if (hashWithdrawalPin(pin, this.hmacSecret) === row.hash) {
      await this.drizzle.db
        .update(user)
        .set({ withdrawalPinFailedAttempts: 0 })
        .where(eq(user.id, userId));
      return { status: 'ok' };
    }
    return this.recordWrongPin(userId, meta);
  }

  /**
   * One statement, so two wrong guesses sent at once each count: a read-then-write would let a
   * burst of parallel requests share one increment and walk past the limit. The fifth wrong PIN
   * starts the lock and zeroes the count, so the first guess after it expires starts a new run.
   */
  private async recordWrongPin(
    userId: User['id'],
    meta: Partial<ClientMeta> | undefined,
  ): Promise<WithdrawalPinVerdict> {
    const next = sql`${user.withdrawalPinFailedAttempts} + 1`;
    const tripped = sql`${next} >= ${WITHDRAWAL_PIN_MAX_FAILED_ATTEMPTS}`;
    const [updated] = await this.drizzle.db
      .update(user)
      .set({
        withdrawalPinFailedAttempts: sql`case when ${tripped} then 0 else ${next} end`,
        withdrawalPinLockedUntil: sql`case when ${tripped} then now() + interval '${sql.raw(String(WITHDRAWAL_PIN_LOCK_MS / 1000))} seconds' else ${user.withdrawalPinLockedUntil} end`,
      })
      .where(eq(user.id, userId))
      .returning({
        attempts: user.withdrawalPinFailedAttempts,
        lockedUntil: user.withdrawalPinLockedUntil,
      });
    if (!updated) {
      return { status: 'not_set' };
    }
    if (updated.attempts === 0 && updated.lockedUntil) {
      await this.announceLock(userId, updated.lockedUntil, meta);
      return { status: 'locked', lockedUntil: updated.lockedUntil };
    }
    return {
      status: 'incorrect',
      attemptsLeft: WITHDRAWAL_PIN_MAX_FAILED_ATTEMPTS - updated.attempts,
    };
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

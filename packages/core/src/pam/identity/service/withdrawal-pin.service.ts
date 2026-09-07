import { ORPCError } from '@orpc/server';
import { eq } from 'drizzle-orm';
import {
  type Auth,
  type EventBus,
  type DrizzleService,
  type NodeHeaders,
  assertRateLimit,
} from '@openora/core/server';
import {
  RATE_LIMIT_KEYS,
  makeRateLimitKey,
  type ClientMeta,
  type IdentityReader,
  type RateLimiterAdapter,
  type SecurityControls,
  type SetWithdrawalPinInput,
  type User,
} from '@openora/core/contracts';
import { user } from '../schema/index.js';
import { getSecurityControls } from './security-controls.service.js';
import { assertFreshReauthentication } from './fresh-reauthentication.service.js';
import { hashWithdrawalPin } from './withdrawal-pin-hash.service.js';
import type { TwoFactorLockoutService } from './two-factor-lockout.service.js';
import { nodeHeadersToHeaders } from '../../shared/headers-mapper.js';

const MINUTE_MS = 60 * 1000;
const WITHDRAWAL_PIN_RATE_LIMIT = {
  limit: 5,
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
  hmacSecret: string;
};

/**
 * Withdrawal PIN as a security control, independent of the login credential and of
 * wallet withdrawal itself (verifying the PIN at withdrawal time is a separate,
 * not-yet-built seam). Set and Change share the one upsert route below; Remove is
 * immediate and un-gated by design (AC), so it deliberately skips fresh reauth.
 */
export class WithdrawalPinService {
  private readonly drizzle: DrizzleService;
  private readonly events: EventBus;
  private readonly limiter: RateLimiterAdapter;
  private readonly auth: Auth;
  private readonly identityReader: IdentityReader;
  private readonly twoFactorLockout?: TwoFactorLockoutService;
  private readonly hmacSecret: string;

  constructor({
    drizzle,
    events,
    limiter,
    auth,
    identityReader,
    twoFactorLockout,
    hmacSecret,
  }: WithdrawalPinServiceDeps) {
    this.drizzle = drizzle;
    this.events = events;
    this.limiter = limiter;
    this.auth = auth;
    this.identityReader = identityReader;
    this.twoFactorLockout = twoFactorLockout;
    this.hmacSecret = hmacSecret;
  }

  private async securityControlsFor(userId: User['id']): Promise<SecurityControls> {
    const controls = await getSecurityControls(this.drizzle, userId);
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

  async remove(userId: User['id'], meta: ClientMeta): Promise<SecurityControls> {
    await assertRateLimit(
      this.limiter,
      makeRateLimitKey(RATE_LIMIT_KEYS.WITHDRAWAL_PIN_MUTATION, userId),
      WITHDRAWAL_PIN_RATE_LIMIT,
    );
    const caller = await this.loadCaller(userId);
    await this.assertPlayer(userId, caller.role, 'remove', meta);

    if (caller.withdrawalPinHash === null) {
      return this.securityControlsFor(userId);
    }
    await this.drizzle.db
      .update(user)
      .set({ withdrawalPinHash: null, withdrawalPinSetAt: null })
      .where(eq(user.id, userId));
    this.events.emit('identity.security.withdrawal_pin.removed', {
      userId,
      playerId: await this.identityReader.getPlayerIdByUserIdSafe(userId),
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return this.securityControlsFor(userId);
  }
}

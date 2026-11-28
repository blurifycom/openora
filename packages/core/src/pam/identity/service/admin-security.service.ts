import { ORPCError } from '@orpc/server';
import {
  type Auth,
  type EventBus,
  DrizzleService,
  createLogger,
  makeConflictError,
} from '@openora/core/server';
import { and, eq, gt, sql } from 'drizzle-orm';
import {
  AuthGuardReasonSchema,
  type AdminSecurityPolicy,
  type AdminSessionContext,
  type AdminSecurityConfig,
  type GeoIpAdapter,
  type ClientMeta,
  type IdentityReader,
  type MailDispatchPort,
  type User,
} from '@openora/core/contracts';
import {
  session,
  twoFactor,
  user,
  type AdminTrustedDevice,
  type Session,
} from '../schema/index.js';
import type { AdminSecurityStatus, TrustedDeviceItem } from '../contract/index.js';
import { isSameDevice, isSuspiciousIpChange } from './device-fingerprint.service.js';
import type { SessionService } from './session.service.js';
import type { TrustedDeviceService } from './trusted-device.service.js';
import { UserNotFoundError } from './identity.service.js';
import { countRemainingBackupCodes } from './backup-codes.service.js';

const logger = createLogger('admin-security');

export const SelfTwoFactorResetError = makeConflictError(
  'SelfTwoFactorResetError',
  'An admin cannot reset their own second factor - ask another Super Admin',
);

export const TwoFactorNotEnabledError = makeConflictError(
  'TwoFactorNotEnabledError',
  'This player has no second factor to reset',
);

const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000;

export type AdminSecurityServiceDeps = {
  drizzle: DrizzleService;
  auth: Auth;
  events: EventBus;
  sessions: SessionService;
  trustedDevices: TrustedDeviceService;
  identityReader: IdentityReader;
  config: AdminSecurityConfig;
  geoIp?: GeoIpAdapter | undefined;
  mailDispatch?: MailDispatchPort | undefined;
};

export class AdminSecurityService implements AdminSecurityPolicy {
  private readonly drizzle: DrizzleService;
  private readonly auth: Auth;
  private readonly events: EventBus;
  private readonly sessions: SessionService;
  private readonly trustedDevices: TrustedDeviceService;
  private readonly identityReader: IdentityReader;
  private readonly config: AdminSecurityConfig;
  private readonly geoIp?: GeoIpAdapter | undefined;
  private readonly mailDispatch?: MailDispatchPort | undefined;

  constructor({
    drizzle,
    auth,
    events,
    sessions,
    trustedDevices,
    identityReader,
    config,
    geoIp,
    mailDispatch,
  }: AdminSecurityServiceDeps) {
    this.mailDispatch = mailDispatch;
    this.drizzle = drizzle;
    this.auth = auth;
    this.events = events;
    this.sessions = sessions;
    this.trustedDevices = trustedDevices;
    this.identityReader = identityReader;
    this.config = config;
    this.geoIp = geoIp;
    if (config.bindSessionToDevice && config.ipChangePolicy === 'country' && !geoIp) {
      logger.warn(
        'adminSecurity.ipChangePolicy is "country" but no GEO_IP_ADAPTER is bound - ' +
          'IP changes will not end a session. Bind a geo-ip adapter or set the policy explicitly.',
      );
    }
  }

  async assertEnrolled({ userId, ip, userAgent }: AdminSessionContext): Promise<void> {
    if (!this.config.requireTwoFactor) {
      return;
    }
    const [row] = await this.drizzle.db
      .select({ twoFactorEnabled: user.twoFactorEnabled })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);

    if (row?.twoFactorEnabled === true) {
      return;
    }

    this.events.emit('identity.2fa.enrollment_blocked', { userId, ip, userAgent });
    throw new ORPCError('FORBIDDEN', {
      message: 'Two-factor authentication must be configured before using the back office',
      data: { reason: AuthGuardReasonSchema.enum.two_factor_required },
    });
  }

  async assertSessionIntact({
    userId,
    sessionId,
    ip,
    userAgent,
  }: AdminSessionContext): Promise<void> {
    if (!this.config.bindSessionToDevice || !sessionId) {
      return;
    }
    const [row] = await this.drizzle.db
      .select({
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
        lastSeenAt: session.lastSeenAt,
        live: sql<boolean>`${session.expiresAt} > now()`,
      })
      .from(session)
      .where(and(eq(session.id, sessionId), eq(session.userId, userId)))
      .limit(1);

    if (!row?.live) {
      throw new ORPCError('UNAUTHORIZED', {
        message: 'Authentication required',
        data: { reason: AuthGuardReasonSchema.enum.authentication_required },
      });
    }

    if (!isSameDevice(row.userAgent, userAgent)) {
      await this.endCompromisedSession({ userId, sessionId, ip, userAgent }, 'user_agent');
    }

    if (await this.hasSuspiciousIpChange(row.ipAddress, ip)) {
      await this.endCompromisedSession({ userId, sessionId, ip, userAgent }, 'ip');
    }

    await this.touchLastSeen(sessionId, row.lastSeenAt);
  }

  private async hasSuspiciousIpChange(
    sessionIp: string | null,
    requestIp: string | null,
  ): Promise<boolean> {
    const policy = this.config.ipChangePolicy;
    if (policy === 'off' || !sessionIp || !requestIp || sessionIp === requestIp) {
      return false;
    }
    if (policy === 'any') {
      return true;
    }
    if (!this.geoIp) {
      return false;
    }
    const [sessionCountry, requestCountry] = await Promise.all([
      this.lookupCountry(sessionIp),
      this.lookupCountry(requestIp),
    ]);
    return isSuspiciousIpChange({
      policy,
      sessionIp,
      requestIp,
      sessionCountry,
      requestCountry,
    });
  }

  private async lookupCountry(ipAddress: string): Promise<string | null> {
    try {
      return (await this.geoIp?.lookup(ipAddress))?.countryCode ?? null;
    } catch (error) {
      logger.warn(`geo-ip lookup failed for a session check: ${String(error)}`);
      return null;
    }
  }

  private async endCompromisedSession(
    { userId, sessionId, ip, userAgent }: AdminSessionContext & { sessionId: Session['id'] },
    mismatch: 'user_agent' | 'ip',
  ): Promise<never> {
    await this.sessions.revokeSession(userId, sessionId, undefined, { ip, userAgent });
    await this.trustedDevices.revokeForDevice(userId, userAgent, undefined);
    this.events.emit('identity.session.fingerprint_mismatch', {
      userId,
      playerId: await this.identityReader.getPlayerIdByUserIdSafe(userId),
      sessionId,
      mismatch,
      ip,
      userAgent,
    });
    throw new ORPCError('UNAUTHORIZED', {
      message: 'Session ended because the device or network changed',
      data: { reason: AuthGuardReasonSchema.enum.session_fingerprint_mismatch },
    });
  }

  private async touchLastSeen(sessionId: Session['id'], lastSeenAt: Date | null): Promise<void> {
    if (lastSeenAt && Date.now() - lastSeenAt.getTime() < LAST_SEEN_THROTTLE_MS) {
      return;
    }
    await this.drizzle.db
      .update(session)
      .set({ lastSeenAt: sql`now()` })
      .where(eq(session.id, sessionId));
  }

  async status(userId: User['id'], userAgent: string | null): Promise<AdminSecurityStatus> {
    const [row] = await this.drizzle.db
      .select({
        twoFactorEnabled: user.twoFactorEnabled,
        twoFactorLockoutUntil: user.twoFactorLockoutUntil,
      })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);

    const twoFactorEnabled = row?.twoFactorEnabled === true;
    const devices = await this.trustedDevices.list(userId, userAgent);
    const currentDevice = devices.find((device) => device.isCurrent);
    const lockedUntil = row?.twoFactorLockoutUntil ?? null;

    return {
      twoFactorEnabled,
      backupCodesRemaining: twoFactorEnabled
        ? await countRemainingBackupCodes(this.auth, userId)
        : null,
      enrollmentRequired: this.config.requireTwoFactor && !twoFactorEnabled,
      trustedDeviceDays: this.config.trustedDeviceDays,
      trustedDeviceUntil: currentDevice?.expiresAt ?? null,
      lockedUntil: lockedUntil ? lockedUntil.toISOString() : null,
    };
  }

  listTrustedDevices(userId: User['id'], userAgent: string | null): Promise<TrustedDeviceItem[]> {
    return this.trustedDevices.list(userId, userAgent);
  }

  async revokeTrustedDevice(
    userId: User['id'],
    deviceId: AdminTrustedDevice['id'],
    actorId: User['id'],
    meta?: ClientMeta,
    keepSessionId?: Session['id'],
  ) {
    const { userAgent } = await this.trustedDevices.revoke(userId, deviceId, actorId, meta);
    await this.endSessionsOnDevice(userId, userAgent, actorId, meta, keepSessionId);
    return { success: true as const };
  }

  private async endSessionsOnDevice(
    userId: User['id'],
    deviceUserAgent: string | null,
    actorId: User['id'],
    meta?: ClientMeta,
    keepSessionId?: Session['id'],
  ): Promise<void> {
    const active = await this.drizzle.db
      .select({ id: session.id, userAgent: session.userAgent })
      .from(session)
      .where(and(eq(session.userId, userId), gt(session.expiresAt, sql`now()`)));

    for (const row of active) {
      if (row.id !== keepSessionId && isSameDevice(row.userAgent, deviceUserAgent)) {
        await this.sessions.revokeSession(userId, row.id, actorId, meta);
      }
    }
  }

  async resetTwoFactor(userId: User['id'], actorId: User['id'], reason: string, meta?: ClientMeta) {
    if (userId === actorId) {
      throw new SelfTwoFactorResetError();
    }
    await this.clearTwoFactor(userId, actorId, reason, meta, { forPlayer: false });
    return { success: true as const };
  }

  async resetPlayerTwoFactor(
    userId: User['id'],
    actorId: User['id'],
    reason: string,
    meta?: ClientMeta,
  ) {
    const { clearedEnrolmentId } = await this.clearTwoFactor(userId, actorId, reason, meta, {
      forPlayer: true,
    });

    try {
      await this.mailDispatch?.toUser({
        userId,
        template: { key: 'twoFactorReset', data: { occurredAt: new Date().toISOString() } },
        idempotencyKey: `two-factor-reset:${clearedEnrolmentId ?? userId}`,
      });
    } catch (err) {
      logger.error({ err, userId }, 'two-factor reset notice enqueue failed');
    }
    return { success: true as const };
  }

  private async clearTwoFactor(
    userId: User['id'],
    actorId: User['id'],
    reason: string,
    meta: ClientMeta | undefined,
    { forPlayer }: { forPlayer: boolean },
  ): Promise<{ clearedEnrolmentId: string | null }> {
    const clearedEnrolmentId = await this.drizzle.db.transaction(async (tx) => {
      const [account] = await tx
        .select({ role: user.role, twoFactorEnabled: user.twoFactorEnabled })
        .from(user)
        .where(eq(user.id, userId))
        .for('update')
        .limit(1);
      if (!account || (forPlayer && account.role !== 'player')) {
        throw new UserNotFoundError(userId);
      }
      if (forPlayer && !account.twoFactorEnabled) {
        throw new TwoFactorNotEnabledError();
      }

      const [cleared] = await tx
        .delete(twoFactor)
        .where(eq(twoFactor.userId, userId))
        .returning({ id: twoFactor.id });
      await tx
        .update(user)
        .set({
          twoFactorEnabled: false,
          twoFactorMethod: null,
          failedTwoFactorAttempts: 0,
          twoFactorLockoutUntil: null,
          ...(forPlayer ? {} : { requireTwoFactorOnLogin: false }),
        })
        .where(eq(user.id, userId));
      return cleared?.id ?? null;
    });

    this.events.emit('identity.2fa.reset', {
      userId,
      playerId: await this.identityReader.getPlayerIdByUserIdSafe(userId),
      actorId,
      reason,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    });

    await this.trustedDevices.revokeAllForUser(userId, actorId);
    await this.sessions.revokeAllSessions(userId, actorId, meta);
    return { clearedEnrolmentId };
  }

  isTrustedDevice(userId: User['id'], userAgent: string | null): Promise<boolean> {
    return this.trustedDevices.isTrusted(userId, userAgent);
  }
}

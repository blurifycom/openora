import { ORPCError } from '@orpc/server';
import { type EventBus, DrizzleService, createLogger } from '@openora/core/server';
import { and, eq, gt, sql } from 'drizzle-orm';
import {
  AuthGuardReasonSchema,
  type AdminSecurityPolicy,
  type AdminSessionContext,
  type AdminSecurityConfig,
  type GeoIpAdapter,
  type ClientMeta,
  type IdentityReader,
  type User,
} from '@openora/core/contracts';
import { session, user, type AdminTrustedDevice, type Session } from '../schema/index.js';
import type { AdminSecurityStatus, TrustedDeviceItem } from '../contract/index.js';
import { isSameDevice, isSuspiciousIpChange } from './device-fingerprint.service.js';
import type { SessionService } from './session.service.js';
import type { TrustedDeviceService } from './trusted-device.service.js';

const logger = createLogger('admin-security');

// Recording activity on every admin request would be one write per call; the session
// list only needs minute-level resolution.
const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000;

export type AdminSecurityServiceDeps = {
  drizzle: DrizzleService;
  events: EventBus;
  sessions: SessionService;
  trustedDevices: TrustedDeviceService;
  identityReader: IdentityReader;
  config: AdminSecurityConfig;
  geoIp?: GeoIpAdapter | undefined;
};

/**
 * Enforcement half of the Backoffice session policy, resolved by `AdminGuard` on every
 * admin request through ADMIN_SECURITY_POLICY.
 *
 * Both checks throw rather than return a verdict: a caller that forgets to branch on a
 * boolean would silently grant access, which is the one failure mode this class exists
 * to prevent.
 */
export class AdminSecurityService implements AdminSecurityPolicy {
  private readonly drizzle: DrizzleService;
  private readonly events: EventBus;
  private readonly sessions: SessionService;
  private readonly trustedDevices: TrustedDeviceService;
  private readonly identityReader: IdentityReader;
  private readonly config: AdminSecurityConfig;
  private readonly geoIp?: GeoIpAdapter | undefined;

  constructor({
    drizzle,
    events,
    sessions,
    trustedDevices,
    identityReader,
    config,
    geoIp,
  }: AdminSecurityServiceDeps) {
    this.drizzle = drizzle;
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
      })
      .from(session)
      .where(and(eq(session.id, sessionId), eq(session.userId, userId)))
      .limit(1);

    if (!row) {
      return;
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

  /**
   * Ends a session whose device or network no longer matches, and drops the trust that
   * device held - otherwise the next login would silently skip the second factor on the
   * very device that just failed the check.
   */
  private async endCompromisedSession(
    { userId, sessionId, ip, userAgent }: AdminSessionContext & { sessionId: Session['id'] },
    mismatch: 'user_agent' | 'ip',
  ): Promise<never> {
    await this.sessions.revokeSession(userId, sessionId, userId, { ip, userAgent });
    await this.trustedDevices.revokeForDevice(userId, userAgent, userId);
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

  /**
   * What the Backoffice needs before it renders anything: whether this account still
   * has to enrol, and whether the browser it is on holds an unexpired trust grant.
   */
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
      enrollmentRequired: this.config.requireTwoFactor && !twoFactorEnabled,
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
  ) {
    const { userAgent } = await this.trustedDevices.revoke(userId, deviceId, actorId, meta);
    await this.endSessionsOnDevice(userId, userAgent, actorId, meta);
    return { success: true as const };
  }

  /**
   * A revoked device loses its live sessions in the same breath, so the grant cannot
   * outlive the revoke on the browser that already holds one.
   */
  private async endSessionsOnDevice(
    userId: User['id'],
    deviceUserAgent: string | null,
    actorId: User['id'],
    meta?: ClientMeta,
  ): Promise<void> {
    const active = await this.drizzle.db
      .select({ id: session.id, userAgent: session.userAgent })
      .from(session)
      .where(and(eq(session.userId, userId), gt(session.expiresAt, sql`now()`)));

    for (const row of active) {
      if (isSameDevice(row.userAgent, deviceUserAgent)) {
        await this.sessions.revokeSession(userId, row.id, actorId, meta);
      }
    }
  }

  isTrustedDevice(userId: User['id'], userAgent: string | null): Promise<boolean> {
    return this.trustedDevices.isTrusted(userId, userAgent);
  }
}

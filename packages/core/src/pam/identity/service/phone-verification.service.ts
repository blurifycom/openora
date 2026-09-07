import { ORPCError } from '@orpc/server';
import { DatabaseError } from 'pg';
import { and, eq, gt, isNotNull, sql } from 'drizzle-orm';
import {
  type Auth,
  type EventBus,
  type DrizzleService,
  type NodeHeaders,
  assertRateLimit,
} from '@openora/core/server';
import type {
  ClientMeta,
  IdentityReader,
  PhoneVerificationConfirmInput,
  PhoneVerificationRequestInput,
  PhoneVerificationRequestOutput,
  RateLimiterAdapter,
  SecurityControls,
  SmsAdapter,
  User,
} from '@openora/core/contracts';
import { account, phoneVerificationSession, user, type Session } from '../schema/index.js';
import { getSecurityControls } from './security-controls.service.js';
import type { TwoFactorLockoutService } from './two-factor-lockout.service.js';
import { nodeHeadersToHeaders } from '../../shared/headers-mapper.js';
import { hashCode, generateCode } from '../../shared/otp.js';

const MINUTE_MS = 60 * 1000;
const OTP_TTL_MS = 5 * MINUTE_MS;
const RESEND_COOLDOWN_MS = MINUTE_MS;
const MAX_VERIFY_ATTEMPTS = 5;
const REAUTH_TTL_MS = 5 * MINUTE_MS;

const REQUEST_RATE_LIMIT = { limit: 3, windowMs: 15 * MINUTE_MS, onUnavailable: 'deny' } as const;
const VERIFY_RATE_LIMIT = { limit: 10, windowMs: 5 * MINUTE_MS, onUnavailable: 'deny' } as const;

function phoneVerificationCooldownError(retryAfterMs: number) {
  return new ORPCError('TOO_MANY_REQUESTS', {
    message: 'A code was already sent. Please wait before requesting another.',
    data: { retryAfterMs },
  });
}

function phoneVerificationInvalidError() {
  return new ORPCError('UNPROCESSABLE_CONTENT', { message: 'The code is invalid or expired.' });
}

function isPhoneNumberCollision(error: unknown): boolean {
  const cause = error instanceof DatabaseError ? error : (error as Error)?.cause;
  return (
    cause instanceof DatabaseError &&
    cause.code === '23505' &&
    cause.constraint === 'user_phoneNumber_unique'
  );
}

type VerifyTotpApi = {
  verifyTOTP(opts: {
    body: { code: string; trustDevice: false };
    headers: Headers;
    asResponse: true;
  }): Promise<Response>;
};

export type PhoneVerificationServiceDeps = {
  drizzle: DrizzleService;
  events: EventBus;
  sms: SmsAdapter;
  limiter: RateLimiterAdapter;
  auth: Auth;
  identityReader: IdentityReader;
  twoFactorLockout?: TwoFactorLockoutService;
};

export class PhoneVerificationService {
  private readonly drizzle: DrizzleService;
  private readonly events: EventBus;
  private readonly sms: SmsAdapter;
  private readonly limiter: RateLimiterAdapter;
  private readonly auth: Auth;
  private readonly identityReader: IdentityReader;
  private readonly twoFactorLockout?: TwoFactorLockoutService;

  constructor({
    drizzle,
    events,
    sms,
    limiter,
    auth,
    identityReader,
    twoFactorLockout,
  }: PhoneVerificationServiceDeps) {
    this.drizzle = drizzle;
    this.events = events;
    this.sms = sms;
    this.limiter = limiter;
    this.auth = auth;
    this.identityReader = identityReader;
    this.twoFactorLockout = twoFactorLockout;
  }

  private async assertFreshReauthentication({
    userId,
    headers,
    currentPassword,
    totpCode,
    twoFactorEnabled,
    meta,
  }: {
    userId: User['id'];
    headers: Headers;
    currentPassword: PhoneVerificationRequestInput['currentPassword'];
    totpCode: PhoneVerificationRequestInput['totpCode'];
    twoFactorEnabled: boolean;
    meta: ClientMeta;
  }) {
    const [credential] = await this.drizzle.db
      .select({ password: account.password })
      .from(account)
      .where(and(eq(account.userId, userId), isNotNull(account.password)))
      .limit(1);
    if (!credential?.password) {
      throw new ORPCError('UNAUTHORIZED', { message: 'Current password is invalid.' });
    }

    const authContext = await this.auth.$context;
    const passwordMatches = await authContext.password.verify({
      password: currentPassword,
      hash: credential.password,
    });
    if (!passwordMatches) {
      throw new ORPCError('UNAUTHORIZED', { message: 'Current password is invalid.' });
    }

    if (!twoFactorEnabled) {
      return;
    }
    if (!totpCode) {
      throw new ORPCError('UNPROCESSABLE_CONTENT', {
        message: 'An authenticator code is required.',
      });
    }

    await this.twoFactorLockout?.assertNotLocked(userId);
    // Library boundary: the base Auth API type omits endpoints contributed by the
    // twoFactor plugin, but createAuth always installs that plugin for identity.
    const api = this.auth.api as unknown as VerifyTotpApi;
    const verification = await api.verifyTOTP({
      body: { code: totpCode, trustDevice: false },
      headers,
      asResponse: true,
    });
    if (!verification.ok) {
      await this.twoFactorLockout?.recordFailure(userId, meta);
      throw new ORPCError('UNAUTHORIZED', { message: 'Invalid authenticator code.' });
    }
    await this.twoFactorLockout?.reset(userId);
  }

  async request({
    userId,
    sessionId,
    input,
    reqHeaders,
    meta,
  }: {
    userId: User['id'];
    sessionId: Session['id'];
    input: PhoneVerificationRequestInput;
    reqHeaders: NodeHeaders;
    meta: ClientMeta;
  }): Promise<PhoneVerificationRequestOutput> {
    await assertRateLimit(this.limiter, `phone-verification-request:${userId}`, REQUEST_RATE_LIMIT);
    const [caller] = await this.drizzle.db
      .select({ role: user.role, twoFactorEnabled: user.twoFactorEnabled })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    if (!caller) {
      throw new ORPCError('UNAUTHORIZED', { message: 'Not signed in.' });
    }
    // A verified number is also a login credential: PhoneLoginService mints a session
    // from an SMS code alone. Binding one therefore stays a player-only control, so a
    // backoffice account cannot trade its password login for a single SMS factor.
    if (caller.role !== 'player') {
      throw new ORPCError('FORBIDDEN', {
        message: 'Only players can verify a phone number.',
      });
    }
    await this.assertFreshReauthentication({
      userId,
      headers: nodeHeadersToHeaders(reqHeaders),
      currentPassword: input.currentPassword,
      totpCode: input.totpCode,
      twoFactorEnabled: caller.twoFactorEnabled ?? false,
      meta,
    });

    const now = new Date();
    const [phoneOwner] = await this.drizzle.db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.phoneNumber, input.phone))
      .limit(1);
    // Anti-enumeration, the same trade PhoneLoginService makes for this identifier: a
    // number owned by someone else answers with the ordinary success shape and no SMS,
    // rather than a CONFLICT that would confirm to any signed-in player that a given
    // number belongs to an account here. No challenge is written, so `confirm` then fails
    // as invalid-or-expired, which is indistinguishable from a wrong code.
    if (phoneOwner && phoneOwner.id !== userId) {
      return {
        expiresAt: new Date(now.getTime() + OTP_TTL_MS).toISOString(),
        resendAfter: new Date(now.getTime() + RESEND_COOLDOWN_MS).toISOString(),
      };
    }

    const [existing] = await this.drizzle.db
      .select({ createdAt: phoneVerificationSession.createdAt })
      .from(phoneVerificationSession)
      .where(
        and(
          eq(phoneVerificationSession.userId, userId),
          gt(phoneVerificationSession.expiresAt, now),
        ),
      )
      .limit(1);
    const elapsedMs = existing ? now.getTime() - existing.createdAt.getTime() : RESEND_COOLDOWN_MS;
    if (elapsedMs < RESEND_COOLDOWN_MS) {
      throw phoneVerificationCooldownError(RESEND_COOLDOWN_MS - elapsedMs);
    }

    const code = generateCode();
    const expiresAt = new Date(now.getTime() + OTP_TTL_MS);
    await this.drizzle.db
      .insert(phoneVerificationSession)
      .values({
        userId,
        sessionId,
        phone: input.phone,
        codeHash: hashCode(code),
        reauthenticatedAt: now,
        expiresAt,
      })
      .onConflictDoUpdate({
        target: phoneVerificationSession.userId,
        set: {
          sessionId,
          phone: input.phone,
          codeHash: hashCode(code),
          reauthenticatedAt: now,
          expiresAt,
          failedAttempts: 0,
          createdAt: now,
        },
      });
    await this.sms.sendOtp({ to: input.phone, code });
    return {
      expiresAt: expiresAt.toISOString(),
      resendAfter: new Date(now.getTime() + RESEND_COOLDOWN_MS).toISOString(),
    };
  }

  async confirm({
    userId,
    sessionId,
    input,
    meta,
  }: {
    userId: User['id'];
    sessionId: Session['id'];
    input: PhoneVerificationConfirmInput;
    meta: ClientMeta;
  }): Promise<SecurityControls> {
    await assertRateLimit(this.limiter, `phone-verification-confirm:${userId}`, VERIFY_RATE_LIMIT);
    const now = new Date();
    const [otp] = await this.drizzle.db
      .select({
        id: phoneVerificationSession.id,
        sessionId: phoneVerificationSession.sessionId,
        phone: phoneVerificationSession.phone,
        codeHash: phoneVerificationSession.codeHash,
        reauthenticatedAt: phoneVerificationSession.reauthenticatedAt,
        failedAttempts: phoneVerificationSession.failedAttempts,
      })
      .from(phoneVerificationSession)
      .where(
        and(
          eq(phoneVerificationSession.userId, userId),
          gt(phoneVerificationSession.expiresAt, now),
        ),
      )
      .limit(1);
    if (
      !otp ||
      otp.sessionId !== sessionId ||
      now.getTime() - otp.reauthenticatedAt.getTime() > REAUTH_TTL_MS
    ) {
      throw phoneVerificationInvalidError();
    }

    if (hashCode(input.code) !== otp.codeHash) {
      // Outside any transaction on purpose: a rejected attempt has to survive the throw
      // that rejects it, and the increment is atomic so concurrent guesses cannot each
      // read a stale count and slip past the cap (same shape as PhoneLoginService).
      const [attempt] = await this.drizzle.db
        .update(phoneVerificationSession)
        .set({ failedAttempts: sql`${phoneVerificationSession.failedAttempts} + 1` })
        .where(eq(phoneVerificationSession.id, otp.id))
        .returning({ failedAttempts: phoneVerificationSession.failedAttempts });
      if (attempt !== undefined && attempt.failedAttempts >= MAX_VERIFY_ATTEMPTS) {
        await this.drizzle.db
          .delete(phoneVerificationSession)
          .where(eq(phoneVerificationSession.id, otp.id));
      }
      throw phoneVerificationInvalidError();
    }

    let previousPhoneVerified = false;
    try {
      await this.drizzle.db.transaction(async (tx) => {
        // Consuming the challenge and binding the number commit together, and the
        // conditional delete is what makes a concurrent second confirm lose the race:
        // only the transaction whose DELETE returns a row proceeds to the update.
        const [consumed] = await tx
          .delete(phoneVerificationSession)
          .where(eq(phoneVerificationSession.id, otp.id))
          .returning({ id: phoneVerificationSession.id });
        if (!consumed) {
          throw phoneVerificationInvalidError();
        }
        // Read before the write: RETURNING yields the new row, and the audit record needs
        // the state this verification replaced.
        const [before] = await tx
          .select({ phoneVerified: user.phoneVerified })
          .from(user)
          .where(eq(user.id, userId))
          .limit(1);
        const [updated] = await tx
          .update(user)
          .set({ phoneNumber: otp.phone, phoneVerified: true, phoneVerifiedAt: new Date() })
          .where(eq(user.id, userId))
          .returning({ id: user.id });
        if (!updated) {
          throw new ORPCError('UNAUTHORIZED', { message: 'Not signed in.' });
        }
        previousPhoneVerified = before?.phoneVerified ?? false;
      });
    } catch (error) {
      if (isPhoneNumberCollision(error)) {
        throw new ORPCError('CONFLICT', { message: 'Phone number is unavailable.' });
      }
      throw error;
    }
    const controls = await getSecurityControls(this.drizzle, userId);
    if (!controls) {
      throw new ORPCError('UNAUTHORIZED', { message: 'Not signed in.' });
    }
    this.events.emit('identity.phone.verified', {
      userId,
      playerId: await this.identityReader.getPlayerIdByUserIdSafe(userId),
      previousPhoneVerified,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return controls;
  }
}

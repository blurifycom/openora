import { createHash, randomInt, randomUUID } from 'node:crypto';
import { ORPCError } from '@orpc/server';
import {
  type EventBus,
  type Auth,
  DrizzleService,
  assertRateLimit,
  signSessionCookie,
  createLogger,
  invalidate,
} from '@openora/core/server';
import { and, eq, gt, sql } from 'drizzle-orm';
import {
  PhoneLoginErrorReasonSchema,
  PhoneLoginOtpInvalidReasonSchema,
  type PhoneLoginOtpInvalidReason,
  type CacheAdapter,
  type RateLimiterAdapter,
  type SmsAdapter,
  type PhoneLoginRequestInput,
  type PhoneLoginRequestOutput,
  type PhoneLoginVerifyInput,
  type User,
  ClientMeta,
} from '@openora/core/contracts';
import { user, session, smsOtpSession } from '../schema/index.js';
import { isRgBlocked } from './rg-guard.service.js';

const MINUTE_MS = 60 * 1000;
const OTP_TTL_MS = 5 * MINUTE_MS;
const RESEND_COOLDOWN_MS = MINUTE_MS;
const MAX_VERIFY_ATTEMPTS = 5;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const REMEMBER_ME_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const OTP_REQUEST_RATE_LIMIT = {
  limit: 3,
  windowMs: 15 * MINUTE_MS,
  onUnavailable: 'deny',
} as const;
const OTP_VERIFY_RATE_LIMIT = {
  limit: 10,
  windowMs: 5 * MINUTE_MS,
  onUnavailable: 'deny',
} as const;

const FAKE_OTP_SHADOW_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type FakeOtpShadow = { createdAt: number; failedAttempts: number };

function phoneOtpShadowKey(phone: string): string {
  return `phone-otp-shadow:${phone}`;
}

const logger = createLogger('phone-otp-shadow');

/** Resend requested before the 60s cooldown elapsed. */
export function OtpCooldownError(retryAfterMs: number) {
  return new ORPCError('TOO_MANY_REQUESTS', {
    message: 'A code was already sent. Please wait before requesting another.',
    data: { retryAfterMs },
  });
}

export function OtpInvalidError(attemptsRemaining: number, reason: PhoneLoginOtpInvalidReason) {
  return new ORPCError('UNPROCESSABLE_CONTENT', {
    message: reason === 'expired' ? 'The code has expired.' : 'The code is invalid.',
    data: { attemptsRemaining, reason: PhoneLoginOtpInvalidReasonSchema.enum[reason] },
  });
}

/** Max wrong attempts reached; the OTP session was invalidated - restart login. */
export function OtpCancelledError() {
  return new ORPCError('FORBIDDEN', {
    message: 'Too many incorrect attempts. Please request a new code.',
    data: { reason: PhoneLoginErrorReasonSchema.enum.otp_cancelled },
  });
}

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

function generateCode(): string {
  const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
  if (process.env['NODE_ENV'] !== 'production') {
    console.log(`SMS Verification code sent: ${code}`); // oxlint-disable-line no-console
  }
  return code;
}

type UserRow = Pick<
  typeof user.$inferSelect,
  | 'id'
  | 'email'
  | 'name'
  | 'emailVerified'
  | 'image'
  | 'theme'
  | 'language'
  | 'phoneNumber'
  | 'phoneVerified'
  | 'createdAt'
  | 'updatedAt'
>;

function serializeUser(u: UserRow): User {
  const base = {
    id: u.id,
    email: u.email,
    name: u.name,
    emailVerified: u.emailVerified,
    theme: u.theme,
    language: u.language,
    phoneNumber: u.phoneNumber,
    phoneVerified: u.phoneVerified,
    createdAt: u.createdAt.toISOString(),
    updatedAt: u.updatedAt.toISOString(),
  };
  return u.image !== null && u.image !== undefined ? { ...base, image: u.image } : base;
}

export type PhoneLoginServiceDeps = {
  drizzle: DrizzleService;
  events: EventBus;
  sms: SmsAdapter;
  limiter: RateLimiterAdapter;
  auth: Auth;
  cache?: CacheAdapter;
};

export class PhoneLoginService {
  private readonly drizzle: DrizzleService;
  private readonly events: EventBus;
  private readonly sms: SmsAdapter;
  private readonly limiter: RateLimiterAdapter;
  private readonly auth: Auth;
  private readonly cache?: CacheAdapter;

  constructor({ drizzle, events, sms, limiter, auth, cache }: PhoneLoginServiceDeps) {
    this.drizzle = drizzle;
    this.events = events;
    this.sms = sms;
    this.limiter = limiter;
    this.auth = auth;
    this.cache = cache;
  }

  private async shadowGet(key: string): Promise<FakeOtpShadow | undefined> {
    if (!this.cache) {
      return undefined;
    }
    try {
      return await this.cache.get<FakeOtpShadow>(key);
    } catch (err) {
      logger.warn({ key, err }, 'phone-otp shadow cache read failed');
      return undefined;
    }
  }

  private async shadowSet(key: string, value: FakeOtpShadow): Promise<void> {
    if (!this.cache) {
      return;
    }
    try {
      await this.cache.set(key, value, { ttlMs: FAKE_OTP_SHADOW_TTL_MS });
    } catch (err) {
      logger.warn({ key, err }, 'phone-otp shadow cache write failed');
    }
  }

  async requestOtp(input: PhoneLoginRequestInput & ClientMeta): Promise<PhoneLoginRequestOutput> {
    const { phone } = input;
    await assertRateLimit(this.limiter, `phone-otp-req:${phone}`, OTP_REQUEST_RATE_LIMIT);

    const now = Date.now();
    const expiresAt = new Date(now + OTP_TTL_MS);
    const resendAfter = new Date(now + RESEND_COOLDOWN_MS);

    const [account] = await this.drizzle.db
      .select({ id: user.id, phoneVerified: user.phoneVerified })
      .from(user)
      .where(eq(user.phoneNumber, phone))
      .limit(1);

    // Anti-enumeration: an unknown or unverified phone gets the same success-shaped
    // response, minus the SMS. A caller cannot distinguish a real verified number from
    // a fake or unverified one.
    if (!account || !account.phoneVerified) {
      const key = phoneOtpShadowKey(phone);
      const shadow = await this.shadowGet(key);
      if (shadow && now - shadow.createdAt < RESEND_COOLDOWN_MS) {
        throw OtpCooldownError(RESEND_COOLDOWN_MS - (now - shadow.createdAt));
      }
      await this.shadowSet(key, { createdAt: now, failedAttempts: 0 });
      return { expiresAt: expiresAt.toISOString(), resendAfter: resendAfter.toISOString() };
    }

    const [existing] = await this.drizzle.db
      .select({ createdAt: smsOtpSession.createdAt })
      .from(smsOtpSession)
      .where(and(eq(smsOtpSession.userId, account.id), gt(smsOtpSession.expiresAt, new Date())))
      .limit(1);

    if (existing && now - existing.createdAt.getTime() < RESEND_COOLDOWN_MS) {
      throw OtpCooldownError(RESEND_COOLDOWN_MS - (now - existing.createdAt.getTime()));
    }

    const code = generateCode();
    const codeHash = hashCode(code);

    await this.drizzle.db
      .insert(smsOtpSession)
      .values({ userId: account.id, phone, codeHash, expiresAt })
      .onConflictDoUpdate({
        target: smsOtpSession.userId,
        set: { phone, codeHash, expiresAt, failedAttempts: 0, createdAt: new Date() },
      });

    await this.sms.sendOtp({ to: phone, code });

    // Emit events only after SMS delivery so a send failure leaves no misleading
    // audit trail (no cancelled-without-requested orphan in the audit log).
    const ip = input.ip ?? null;
    const userAgent = input.userAgent ?? null;
    if (existing) {
      this.events.emit('identity.phone_otp.cancelled', {
        userId: account.id,
        reason: 'new_otp_requested',
        ip,
        userAgent,
      });
    }
    this.events.emit('identity.phone_otp.requested', { userId: account.id, ip, userAgent });

    return { expiresAt: expiresAt.toISOString(), resendAfter: resendAfter.toISOString() };
  }

  async verifyOtp(input: PhoneLoginVerifyInput & ClientMeta, resHeaders: Headers) {
    const { phone, code, rememberMe, ip = null, userAgent = null } = input;
    await assertRateLimit(this.limiter, `phone-otp-verify:${phone}`, OTP_VERIFY_RATE_LIMIT);

    const [otp] = await this.drizzle.db
      .select({
        id: smsOtpSession.id,
        userId: smsOtpSession.userId,
        codeHash: smsOtpSession.codeHash,
        expiresAt: smsOtpSession.expiresAt,
        failedAttempts: smsOtpSession.failedAttempts,
      })
      .from(smsOtpSession)
      .where(eq(smsOtpSession.phone, phone))
      .limit(1);

    if (!otp) {
      const key = phoneOtpShadowKey(phone);
      const shadow = await this.shadowGet(key);
      if (!shadow) {
        throw OtpInvalidError(MAX_VERIFY_ATTEMPTS - 1, 'wrong_code');
      }
      if (Date.now() - shadow.createdAt >= OTP_TTL_MS) {
        throw OtpInvalidError(MAX_VERIFY_ATTEMPTS - shadow.failedAttempts, 'expired');
      }
      const newAttempts = shadow.failedAttempts + 1;
      if (newAttempts >= MAX_VERIFY_ATTEMPTS) {
        await invalidate(this.cache, key);
        throw OtpCancelledError();
      }
      await this.shadowSet(key, { createdAt: shadow.createdAt, failedAttempts: newAttempts });
      throw OtpInvalidError(MAX_VERIFY_ATTEMPTS - newAttempts, 'wrong_code');
    }
    if (otp.expiresAt.getTime() < Date.now()) {
      throw OtpInvalidError(MAX_VERIFY_ATTEMPTS - otp.failedAttempts, 'expired');
    }

    if (hashCode(code) !== otp.codeHash) {
      // Atomic increment so concurrent guesses can't each read a stale count and slip
      // past the cap.
      // Individual wrong-code attempts are not emitted as audit events; the final
      // `identity.phone_otp.cancelled` event captures the outcome. High-volume
      // per-attempt events would bloat the audit log (same rationale as chat messages).
      const [row] = await this.drizzle.db
        .update(smsOtpSession)
        .set({ failedAttempts: sql`${smsOtpSession.failedAttempts} + 1` })
        .where(eq(smsOtpSession.id, otp.id))
        .returning({ failedAttempts: smsOtpSession.failedAttempts });
      const newAttempts = row?.failedAttempts;

      // row is undefined when a concurrent request already deleted the session after
      // hitting the cap — treat it as already cancelled; skip the emit to avoid
      // duplicates.
      if (newAttempts === undefined || newAttempts >= MAX_VERIFY_ATTEMPTS) {
        if (newAttempts !== undefined) {
          await this.drizzle.db.delete(smsOtpSession).where(eq(smsOtpSession.id, otp.id));
          this.events.emit('identity.phone_otp.cancelled', {
            userId: otp.userId,
            reason: 'max_attempts',
            ip,
            userAgent,
          });
        }
        throw OtpCancelledError();
      }
      throw OtpInvalidError(MAX_VERIFY_ATTEMPTS - newAttempts, 'wrong_code');
    }

    // Resolve the account before entering the transaction so the RG check can short-
    // circuit without consuming the OTP: a blocked user can try again once unblocked.
    const [account] = await this.drizzle.db
      .select({
        id: user.id,
        email: user.email,
        name: user.name,
        emailVerified: user.emailVerified,
        image: user.image,
        theme: user.theme,
        language: user.language,
        phoneNumber: user.phoneNumber,
        phoneVerified: user.phoneVerified,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        rgBlocked: user.rgBlocked,
        rgBlockedUntil: user.rgBlockedUntil,
      })
      .from(user)
      .where(eq(user.id, otp.userId))
      .limit(1);
    if (!account) {
      throw new ORPCError('INTERNAL_SERVER_ERROR', { message: 'Account not found.' });
    }

    // RG login block applied only AFTER the OTP verifies so a probe can't distinguish
    // a restricted account from a wrong code.
    if (isRgBlocked(account)) {
      this.events.emit('rg.exclusion.login_blocked', { userId: account.id, ip, userAgent });
      throw new ORPCError('FORBIDDEN', {
        message: 'Account access is currently restricted (responsible gambling).',
        data: { reason: PhoneLoginErrorReasonSchema.enum.rg_blocked },
      });
    }

    // Mint the session directly - bypasses better-auth's TOTP plugin chain by design,
    // so phone login never triggers a second factor.
    // Delete the OTP and insert the new session atomically: if the insert fails the
    // OTP is not consumed and the user can retry with the same code.
    const token = randomUUID();
    const sessionExpiresAt = new Date(
      Date.now() + (rememberMe ? REMEMBER_ME_TTL_MS : SESSION_TTL_MS),
    );
    await this.drizzle.db.transaction(async (t) => {
      await t.delete(smsOtpSession).where(eq(smsOtpSession.id, otp.id));
      await t.insert(session).values({
        id: randomUUID(),
        token,
        userId: account.id,
        expiresAt: sessionExpiresAt,
        ipAddress: ip,
        userAgent,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    });

    this.events.emit('identity.user.phone_login', {
      userId: account.id,
      method: 'phone',
      ip,
      userAgent,
    });

    const authContext = await this.auth.$context;

    const maxAgeSeconds = rememberMe
      ? Math.max(0, Math.round((sessionExpiresAt.getTime() - Date.now()) / 1000))
      : undefined;
    resHeaders.append(
      'set-cookie',
      signSessionCookie({
        token,
        sessionCookie: authContext.authCookies.sessionToken,
        secret: authContext.secret,
        maxAgeSeconds,
      }),
    );

    if (!rememberMe) {
      resHeaders.append(
        'set-cookie',
        signSessionCookie({
          token: 'true',
          sessionCookie: authContext.authCookies.dontRememberToken,
          secret: authContext.secret,
        }),
      );
    }

    return {
      user: serializeUser(account),
      session: { token, expiresAt: sessionExpiresAt.toISOString() },
    };
  }
}

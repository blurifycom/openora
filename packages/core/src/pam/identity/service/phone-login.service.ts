import { createHash, randomInt, randomUUID } from 'node:crypto';
import { ORPCError } from '@orpc/server';
import { type EventBus, DrizzleService, assertRateLimit } from '@openora/core/server';
import { eq, sql } from 'drizzle-orm';
import type {
  RateLimiterAdapter,
  SmsAdapter,
  PhoneLoginRequestInput,
  PhoneLoginRequestOutput,
  PhoneLoginVerifyInput,
  User,
} from '@openora/core/contracts';
import { user, session, smsOtpSession } from '../schema/index.js';

const MINUTE_MS = 60 * 1000;
const OTP_TTL_MS = 5 * MINUTE_MS;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_VERIFY_ATTEMPTS = 5;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const REMEMBER_ME_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Fixed-window abuse throttles keyed by phone. Both fail closed (`deny`): an
// unthrottled OTP-request or OTP-guess window is a credential-guessing surface, so a
// transient limiter outage must not open it.
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

/** Resend requested before the 60s cooldown elapsed. */
export function OtpCooldownError(retryAfterMs: number) {
  return new ORPCError('TOO_MANY_REQUESTS', {
    message: 'A code was already sent. Please wait before requesting another.',
    data: { retryAfterMs },
  });
}

/** Wrong or expired code, session still alive. */
export function OtpInvalidError(attemptsRemaining: number) {
  return new ORPCError('UNPROCESSABLE_CONTENT', {
    message: 'The code is invalid or has expired.',
    data: { attemptsRemaining },
  });
}

/** Max wrong attempts reached; the OTP session was invalidated - restart login. */
export function OtpCancelledError() {
  return new ORPCError('FORBIDDEN', {
    message: 'Too many incorrect attempts. Please request a new code.',
  });
}

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

function generateCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

function isRgBlocked(u: { rgBlocked: boolean; rgBlockedUntil: Date | null }): boolean {
  return u.rgBlocked && (u.rgBlockedUntil === null || u.rgBlockedUntil > new Date());
}

// Fields the OTP flow returns to the caller; the phone-login response mirrors the
// public UserSchema, so serialize the row's timestamps to ISO strings.
function serializeUser(u: typeof user.$inferSelect): User {
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
  limiter?: RateLimiterAdapter;
};

export class PhoneLoginService {
  private readonly drizzle: DrizzleService;
  private readonly events: EventBus;
  private readonly sms: SmsAdapter;
  private readonly limiter?: RateLimiterAdapter;

  constructor({ drizzle, events, sms, limiter }: PhoneLoginServiceDeps) {
    this.drizzle = drizzle;
    this.events = events;
    this.sms = sms;
    this.limiter = limiter;
  }

  async requestOtp(
    input: PhoneLoginRequestInput & { ip?: string | null; userAgent?: string | null },
  ): Promise<PhoneLoginRequestOutput> {
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

    // Anti-enumeration: an unknown phone gets the same success-shaped response, minus
    // the SMS. A caller cannot distinguish a real number from a fake one.
    if (!account) {
      return { expiresAt: expiresAt.toISOString(), resendAfter: resendAfter.toISOString() };
    }

    if (!account.phoneVerified) {
      throw new ORPCError('FORBIDDEN', {
        message: 'Phone number is not verified on this account.',
      });
    }

    const [existing] = await this.drizzle.db
      .select({ createdAt: smsOtpSession.createdAt })
      .from(smsOtpSession)
      .where(eq(smsOtpSession.userId, account.id))
      .limit(1);

    if (existing && now - existing.createdAt.getTime() < RESEND_COOLDOWN_MS) {
      throw OtpCooldownError(RESEND_COOLDOWN_MS - (now - existing.createdAt.getTime()));
    }

    // Invalidate any prior code before issuing a new one - one live OTP per user.
    await this.drizzle.db.delete(smsOtpSession).where(eq(smsOtpSession.userId, account.id));
    if (existing) {
      this.events.emit('identity.phone_otp.cancelled', {
        userId: account.id,
        reason: 'new_otp_requested',
      });
    }

    const code = generateCode();
    await this.drizzle.db.insert(smsOtpSession).values({
      userId: account.id,
      phone,
      codeHash: hashCode(code),
      expiresAt,
    });

    await this.sms.sendOtp({ to: phone, code });
    this.events.emit('identity.phone_otp.requested', { userId: account.id });

    return { expiresAt: expiresAt.toISOString(), resendAfter: resendAfter.toISOString() };
  }

  async verifyOtp(
    input: PhoneLoginVerifyInput & { ip?: string | null; userAgent?: string | null },
  ) {
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
      throw OtpInvalidError(0);
    }
    if (otp.expiresAt.getTime() < Date.now()) {
      throw OtpInvalidError(MAX_VERIFY_ATTEMPTS - otp.failedAttempts);
    }

    if (hashCode(code) !== otp.codeHash) {
      // Atomic increment so concurrent guesses can't each read a stale count and slip
      // past the cap.
      const [row] = await this.drizzle.db
        .update(smsOtpSession)
        .set({ failedAttempts: sql`${smsOtpSession.failedAttempts} + 1` })
        .where(eq(smsOtpSession.id, otp.id))
        .returning({ failedAttempts: smsOtpSession.failedAttempts });
      const newAttempts = row?.failedAttempts ?? MAX_VERIFY_ATTEMPTS;

      if (newAttempts >= MAX_VERIFY_ATTEMPTS) {
        await this.drizzle.db.delete(smsOtpSession).where(eq(smsOtpSession.id, otp.id));
        this.events.emit('identity.phone_otp.cancelled', {
          userId: otp.userId,
          reason: 'max_attempts',
        });
        throw OtpCancelledError();
      }
      throw OtpInvalidError(MAX_VERIFY_ATTEMPTS - newAttempts);
    }

    // Correct code: single-use, so remove the session before minting a login session.
    await this.drizzle.db.delete(smsOtpSession).where(eq(smsOtpSession.id, otp.id));

    const [account] = await this.drizzle.db
      .select()
      .from(user)
      .where(eq(user.id, otp.userId))
      .limit(1);
    if (!account) {
      throw new ORPCError('INTERNAL_SERVER_ERROR', { message: 'Account not found.' });
    }

    // RG login block, applied only AFTER the OTP verifies so a probe can't distinguish a
    // restricted account from a wrong code.
    if (isRgBlocked(account)) {
      this.events.emit('rg.exclusion.login_blocked', { userId: account.id, ip, userAgent });
      throw new ORPCError('FORBIDDEN', {
        message: 'Account access is currently restricted (responsible gambling).',
      });
    }

    // Mint the session directly - bypasses better-auth's TOTP plugin chain by design,
    // so phone login never triggers a second factor.
    const token = randomUUID();
    const expiresAt = new Date(Date.now() + (rememberMe ? REMEMBER_ME_TTL_MS : SESSION_TTL_MS));
    await this.drizzle.db.insert(session).values({
      id: randomUUID(),
      token,
      userId: account.id,
      expiresAt,
      ipAddress: ip,
      userAgent,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    this.events.emit('identity.user.phone_login', {
      userId: account.id,
      method: 'phone',
      ip,
      userAgent,
    });

    return {
      user: serializeUser(account),
      session: { token, expiresAt: expiresAt.toISOString() },
    };
  }
}

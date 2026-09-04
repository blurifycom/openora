import { ORPCError } from '@orpc/server';
import {
  createAuth,
  type EventBus,
  type NodeHeaders,
  DrizzleService,
  assertRateLimit,
  extractClientMeta,
  getCurrentClientMeta,
  findOneOrThrow,
  makeConflictError,
  makeNotFoundError,
  createLogger,
} from '@openora/core/server';
import { parseCookies } from 'better-auth/cookies';
import { and, eq, isNull, sql } from 'drizzle-orm';
import * as z from 'zod';
import { user, session, account, verification, twoFactor } from '../schema/index.js';
import { captureTimezone } from './capture-timezone.service.js';
import type { SessionService } from './session.service.js';
import type { TrustedDeviceService } from './trusted-device.service.js';
import type { TwoFactorLockoutService } from './two-factor-lockout.service.js';
import type {
  CacheAdapter,
  RateLimiterAdapter,
  RateLimitKey,
  SendEmailPort,
  EmailTemplateRenderer,
  LoginInput,
  RegisterInput,
  Enable2faInput,
  Verify2faInput,
  Disable2faInput,
  RegenerateBackupCodesInput,
  TrustCurrentDeviceInput,
  RequestPasswordResetInput,
  VerifyPasswordResetOtpInput,
  ResetPasswordInput,
  ResendEmailVerificationInput,
  VerifyEmailInput,
  UpdateProfileInput,
  Theme,
  User,
  IdentityReader,
  ChangePasswordInput,
  ChangeEmailInput,
  IdentityServiceOptions,
  PlatformConfig,
  ClientMeta,
  RegistrationFailureReason,
  GeoCheckCommands,
  PlayerProvisioning,
} from '@openora/core/contracts';
import { RATE_LIMIT_KEYS, makeRateLimitKey } from '@openora/core/contracts';
import { assertSupportedLanguage } from '../../shared/language.js';
import { assertAccountNotBlocked } from './rg-guard.service.js';
import {
  DEFAULT_LOCKOUT_DURATION_MS,
  DEFAULT_MAX_LOGIN_ATTEMPTS,
  computeLockoutTier,
  createAccountLockedError,
  hasFailedLoginWindowExpired,
  makeLoginSecurityState,
} from './lockout-policy.service.js';

function nodeHeadersToHeaders(nodeHeaders: NodeHeaders) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(nodeHeaders)) {
    if (value === undefined) {
      continue;
    }
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  return headers;
}

// better-auth returns Date objects and may omit theme/language; the public
// UserSchema requires ISO strings and always-present values.
type BetterAuthUser = Omit<User, 'theme' | 'language' | 'createdAt' | 'updatedAt'> & {
  theme?: Theme | null;
  language?: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toUser(u: BetterAuthUser) {
  const base = {
    id: u.id,
    email: u.email,
    name: u.name,
    username: u.username,
    emailVerified: u.emailVerified,
    theme: u.theme ?? 'system',
    language: u.language ?? 'en',
    twoFactorEnabled: u.twoFactorEnabled ?? false,
    createdAt: toIso(u.createdAt),
    updatedAt: toIso(u.updatedAt),
  };
  return u.image !== undefined ? { ...base, image: u.image } : base;
}

function makeLoginRateLimitKey(email: string): `login:${string}` {
  return `login:${email.toLowerCase()}`;
}

// Key on the `.two_factor` cookie VALUE, never the raw Cookie header: an attacker can
// otherwise churn the rate-limit key each retry by appending unrelated cookie pairs.
function twoFactorPendingCookieValue(headers: Headers): string | undefined {
  const cookieHeader = headers.get('cookie');
  if (!cookieHeader) {
    return undefined;
  }
  for (const [name, value] of parseCookies(cookieHeader)) {
    if (name.endsWith('.two_factor')) {
      return value;
    }
  }
  return undefined;
}

// A web Response exposes Set-Cookie as full attribute strings; a request carries only
// the name=value pairs.
function requestCookieHeader(res: globalThis.Response): string {
  return (res.headers.getSetCookie?.() ?? [])
    .map((cookie) => {
      const [pair = ''] = cookie.split(';');
      return pair.trim();
    })
    .filter((pair) => pair.length > 0)
    .join('; ');
}

function hasTrustDeviceCookie(headers: Headers): boolean {
  const cookieHeader = headers.get('cookie');
  if (!cookieHeader) {
    return false;
  }
  for (const [name] of parseCookies(cookieHeader)) {
    if (name.endsWith('.trust_device')) {
      return true;
    }
  }
  return false;
}

// Drops the one pair and leaves every other byte alone: the cookies that stay carry
// signed, percent-encoded values better-auth re-verifies exactly as the browser sent them.
function withoutTrustDeviceCookie(headers: Headers): Headers {
  const cookieHeader = headers.get('cookie');
  if (!cookieHeader) {
    return headers;
  }
  const kept = cookieHeader
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => {
      const [name = ''] = pair.split('=');
      return !name.endsWith('.trust_device');
    });
  const next = new Headers(headers);
  if (kept.length === 0) {
    next.delete('cookie');
  } else {
    next.set('cookie', kept.join('; '));
  }
  return next;
}

// createAuth() is cast to the base better-auth `Auth` type (to dodge the Zod v4
// $strip portability error), so the twoFactor() plugin endpoints are absent from
// the static type. We declare the narrow shapes we call and route through a typed
// accessor - no `any`. asResponse:true makes every call return a web Response.
type AuthCall<B> = (opts: {
  body?: B;
  query?: Record<string, string>;
  headers: Headers;
  asResponse: true;
}) => Promise<globalThis.Response>;

type ExtendedAuthApi = {
  signUpEmail: AuthCall<
    Pick<typeof user.$inferInsert, 'email' | 'name' | 'username'> & { password: string }
  >;
  enableTwoFactor: AuthCall<{ password: string }>;
  verifyTOTP: AuthCall<{ code: string; trustDevice?: boolean }>;
  verifyBackupCode: AuthCall<{ code: string; trustDevice?: boolean }>;
  generateBackupCodes: AuthCall<{ password: string }>;
  disableTwoFactor: AuthCall<{ password: string }>;
  requestPasswordResetEmailOTP: AuthCall<{ email: string }>;
  checkVerificationOTP: AuthCall<{ email: string; type: 'forget-password'; otp: string }>;
  resetPasswordEmailOTP: AuthCall<{ email: string; otp: string; password: string }>;
  sendVerificationOTP: AuthCall<{ email: string; type: 'email-verification' }>;
  verifyEmailOTP: AuthCall<{ email: string; otp: string }>;
  changePassword: AuthCall<{ currentPassword: string; newPassword: string }>;
  changeEmail: AuthCall<{ newEmail: string }>;
  updateUser: AuthCall<{ name?: string; image?: string | null; theme?: Theme; language?: string }>;
};

const SUCCESS = { success: true as const };

export const UserNotFoundError = makeNotFoundError('User');
export const UsernameConflictError = makeConflictError('Username', 'Username is already in use');

const BetterAuthErrorBodySchema = z.object({
  message: z.string().optional(),
  code: z.string().optional(),
});

// better-auth calls use `asResponse: true`, which returns an error *Response*
// (4xx/5xx) rather than throwing. Surface those as ORPCErrors so oRPC maps them
// to the right HTTP status instead of the handler silently returning success.
// Only reads the body on failure, so a subsequent res.json() on success is safe.
// 401 -> UNAUTHORIZED (bad credentials), 403 -> FORBIDDEN (better-auth's
// TOO_MANY_ATTEMPTS on checkVerificationOTP/resetPasswordEmailOTP), else BAD_REQUEST.
// `opts.genericMessage` lets a BAD_REQUEST *or* FORBIDDEN caller opt into a fixed
// message instead of better-auth's raw one - some better-auth 400s (eg
// checkVerificationOTP's USER_NOT_FOUND-before-INVALID_OTP ordering) leak account
// existence otherwise. When genericMessage is set, a 403 is masked down to
// BAD_REQUEST too, so a caller can't tell "too many attempts" apart from "wrong code".
async function ensureOk(res: globalThis.Response, opts?: { genericMessage?: string }) {
  if (res.ok) {
    return;
  }
  const code =
    res.status === 401 ? 'UNAUTHORIZED' : res.status === 403 ? 'FORBIDDEN' : 'BAD_REQUEST';
  if ((code === 'BAD_REQUEST' || code === 'FORBIDDEN') && opts?.genericMessage) {
    throw new ORPCError(code === 'FORBIDDEN' ? 'BAD_REQUEST' : code, {
      message: opts.genericMessage,
    });
  }
  let message = `Request failed (${res.status})`;
  let betterAuthCode: string | undefined;
  const body = BetterAuthErrorBodySchema.safeParse(await res.json().catch(() => null));
  if (body.success) {
    if (body.data.message) {
      message = body.data.message;
    }
    if (body.data.code) {
      betterAuthCode = body.data.code;
    }
  }
  throw new ORPCError(code, {
    message,
    ...(betterAuthCode ? { data: { code: betterAuthCode } } : {}),
  });
}

const MINUTE_MS = 60 * 1000;
export const SESSION_DURATION_IN_SECONDS = 30 * 24 * 60 * 60; // 30 days
// Coarse abuse throttles keyed by the caller identifier the context provides (email/
// token/session), NOT IP. The lockout above is a per-account credential-failure
// counter; these bound raw request volume on each brute-force surface. An overlay
// rebinds RATE_LIMITER to change the backend, not the policy - the numbers are here.
// Credential-guessing keys fail closed when the limiter backend is down: an
// unthrottled login/2fa/reset window is worse than a transient 429. The volume
// throttles (register/resend/etc.) keep the default fail-open.
const LOGIN_RATE_LIMIT = { limit: 10, windowMs: 5 * MINUTE_MS, onUnavailable: 'deny' } as const;
const REGISTER_RATE_LIMIT = { limit: 5, windowMs: 15 * MINUTE_MS };
// Keyed on the caller, not the handle: the abuse shape here is enumerating many
// usernames from one client, not probing one username repeatedly.
const USERNAME_AVAILABILITY_RATE_LIMIT = { limit: 30, windowMs: MINUTE_MS };
const PASSWORD_RESET_REQUEST_RATE_LIMIT = { limit: 3, windowMs: 15 * MINUTE_MS };
const PASSWORD_RESET_RATE_LIMIT = {
  limit: 5,
  windowMs: 15 * MINUTE_MS,
  onUnavailable: 'deny',
} as const;
const PASSWORD_RESET_VERIFY_RATE_LIMIT = {
  limit: 5,
  windowMs: 5 * MINUTE_MS,
  onUnavailable: 'deny',
} as const;
const VERIFY_2FA_RATE_LIMIT = { limit: 5, windowMs: 5 * MINUTE_MS, onUnavailable: 'deny' } as const;
// Fails closed with the verify budget below: better-auth issues a fresh code (and a fresh
// 3-attempt counter) per resend, so an unbounded resend loop is an unbounded guess budget.
const EMAIL_VERIFICATION_RATE_LIMIT = {
  limit: 3,
  windowMs: 15 * MINUTE_MS,
  onUnavailable: 'deny',
} as const;
// Fails closed like the other secret-guessing budgets: the emailed code is six digits,
// so an unthrottled window is a brute-force window, not a degraded-UX window.
const VERIFY_EMAIL_RATE_LIMIT = {
  limit: 5,
  windowMs: 15 * MINUTE_MS,
  onUnavailable: 'deny',
} as const;
const CHANGE_PASSWORD_RATE_LIMIT = { limit: 5, windowMs: 15 * MINUTE_MS };
const TWO_FACTOR_PASSWORD_RATE_LIMIT = { limit: 5, windowMs: 5 * MINUTE_MS };
const FAKE_LOGIN_SHADOW_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type FakeLoginShadow = {
  failedAttempts: number;
  lockoutUntil: string | null;
  lockoutCount: number;
  lastLockoutAt: string | null;
  lastFailedLoginAt: string | null;
};

function loginShadowKey(email: string): string {
  return `login-shadow:${email}`;
}

const loginShadowLogger = createLogger('login-shadow');
const identityLogger = createLogger('identity');

function hasErrorCode(error: unknown, code: string) {
  if (typeof error !== 'object' || error === null || !('data' in error)) {
    return false;
  }

  const data = error.data;
  return typeof data === 'object' && data !== null && 'code' in data && data.code === code;
}

function computeLockoutState({
  attempts,
  maxAttempts,
  durationMs,
  nowMs,
}: {
  attempts: number;
  maxAttempts: number;
  durationMs: number;
  nowMs: number;
}) {
  const isLocking = attempts >= maxAttempts;
  return { isLocking, lockoutUntil: isLocking ? new Date(nowMs + durationMs) : null };
}

export type IdentityServiceDeps = {
  drizzle: DrizzleService;
  events: EventBus;
  identityReader: IdentityReader;
  email?: SendEmailPort;
  templateRenderer: EmailTemplateRenderer;
  options?: IdentityServiceOptions;
  limiter?: RateLimiterAdapter<RateLimitKey>;
  platformConfig?: PlatformConfig;
  geoCheck?: GeoCheckCommands;
  playerProvisioning?: PlayerProvisioning;
  cache?: CacheAdapter;
  trustedDevices?: TrustedDeviceService;
  twoFactorLockout?: TwoFactorLockoutService;
  // Used by the step-up self-service routes (disable 2FA, regenerate backup codes) to
  // tear down live sessions once the account's standing credentials have changed.
  sessions?: SessionService;
};

/**
 * Thin wrapper over the shared better-auth instance (register/login/2FA/
 * password/email flows) that layers on platform-specific policy better-auth
 * doesn't provide: per-account lockout after N failed logins, RG
 * (responsible-gambling) login blocking, and rate limiting keyed by
 * caller-identifier (email/token/session), never IP. better-auth calls use
 * `asResponse: true` and return an error Response rather than throwing, so
 * every call is routed through `ensureOk` to surface failures as `ORPCError`s.
 */
export class IdentityService {
  private readonly auth: ReturnType<typeof createAuth>;
  private readonly drizzle: DrizzleService;
  private readonly events: EventBus;
  private readonly identityReader: IdentityReader;
  private readonly email?: SendEmailPort;
  private readonly templateRenderer: EmailTemplateRenderer;
  private readonly options?: IdentityServiceOptions;
  private readonly limiter?: RateLimiterAdapter<RateLimitKey>;
  private readonly platformConfig?: PlatformConfig;
  private readonly playerProvisioning?: PlayerProvisioning;
  private readonly geoCheck?: GeoCheckCommands;
  private readonly cache?: CacheAdapter;
  // Addresses whose reset code is being sent because a sign-up hit an existing account.
  // Held only for the duration of that send: `requestPasswordResetEmailOTP` drives
  // `sendVerificationOTP` -> `render` inside the same await, so the flag is read before
  // the `finally` clears it. Not cache-backed - it never has to outlive the call or
  // cross a process.
  private readonly existingAccountSignUps = new Set<string>();
  private readonly trustedDevices?: TrustedDeviceService;
  private readonly twoFactorLockout?: TwoFactorLockoutService;
  private readonly sessions?: SessionService;

  constructor({
    drizzle,
    events,
    identityReader,
    email,
    templateRenderer,
    options,
    limiter,
    platformConfig,
    geoCheck,
    playerProvisioning,
    cache,
    trustedDevices,
    twoFactorLockout,
    sessions,
  }: IdentityServiceDeps) {
    this.drizzle = drizzle;
    this.events = events;
    this.identityReader = identityReader;
    this.email = email;
    this.templateRenderer = templateRenderer;
    this.options = options;
    this.limiter = limiter;
    this.platformConfig = platformConfig;
    this.geoCheck = geoCheck;
    this.playerProvisioning = playerProvisioning;
    this.cache = cache;
    this.trustedDevices = trustedDevices;
    this.twoFactorLockout = twoFactorLockout;
    this.sessions = sessions;
    this.auth = createAuth({
      db: drizzle.db,
      schema: { user, session, account, verification, twoFactor },
      ...(email ? { sendEmail: (args) => email.send(args) } : {}),
      templateRenderer: this.templateRenderer,
      getUserLanguage: (lookupEmail) => this.resolveUserLanguage(lookupEmail),
      requireEmailVerification:
        this.platformConfig?.registration?.requireEmailVerification ?? false,
      isExistingAccountSignUp: (lookupEmail) =>
        this.existingAccountSignUps.has(lookupEmail.toLowerCase()),
      onExistingUserSignUp: async (existing) => {
        const key = existing.email.toLowerCase();
        this.existingAccountSignUps.add(key);
        try {
          const response = await this.api.requestPasswordResetEmailOTP({
            body: { email: existing.email },
            headers: new Headers(),
            asResponse: true,
          });
          await ensureOk(response);
        } finally {
          this.existingAccountSignUps.delete(key);
        }
      },
      onPasswordReset: async (resetUser) => {
        this.events.emit('identity.password.reset', {
          userId: resetUser.id,
          playerId: await this.identityReader.getPlayerIdByUserIdSafe(resetUser.id),
          ...getCurrentClientMeta(),
        });
        await this.clearLockout(resetUser.id);
      },
    });
  }

  private async findUserByEmail(
    email: string,
  ): Promise<{ id: User['id']; language: string | null } | undefined> {
    const [row] = await this.drizzle.db
      .select({ id: user.id, language: user.language })
      .from(user)
      .where(eq(user.email, email.toLowerCase()))
      .limit(1);
    return row;
  }

  // Used by the emailOTP plugin's sendVerificationOTP hook to pick a locale for the
  // reset-password email - better-auth only gives us the target email, not a session.
  private async resolveUserLanguage(email: string): Promise<string | null> {
    const row = await this.findUserByEmail(email);
    return row?.language ?? null;
  }

  private get api() {
    // Library boundary: the admin/organization plugin endpoints aren't on better-auth's
    // base `api` type. Sanctioned cast, see conventions.
    return this.auth.api as unknown as ExtendedAuthApi;
  }

  private forwardCookies(authResponse: globalThis.Response, resHeaders: Headers): void {
    const cookies = authResponse.headers.getSetCookie?.() ?? [];
    for (const cookie of cookies) {
      resHeaders.append('set-cookie', cookie);
    }
  }

  private async currentUserId(headers: Headers) {
    const session = await this.auth.api.getSession({ headers });
    return session?.user?.id ?? null;
  }

  // Same gate as password login and phone login, from the one shared implementation.
  private assertAccountNotBlocked(
    account: { id: User['id']; rgBlocked: boolean; rgBlockedUntil: Date | null },
    meta: ClientMeta,
  ): Promise<string | null> {
    return assertAccountNotBlocked({ drizzle: this.drizzle, events: this.events }, account, meta, {
      revokeSessions: true,
      errorData: { rgBlocked: { code: 'RG_BLOCKED' }, suspended: { code: 'ACCOUNT_SUSPENDED' } },
    });
  }

  /**
   * Emitted on every registration attempt that produced no account. The audit trail is
   * the one place that records what actually happened - the HTTP response deliberately
   * does not, because a truthful answer on a known address is an enumeration oracle.
   */
  private emitRegistrationFailed(
    reason: RegistrationFailureReason,
    input: RegisterInput,
    { ip, userAgent }: ClientMeta,
  ) {
    this.events.emit('identity.user.registration.failed', {
      email: input.email,
      username: input.username,
      reason,
      ip,
      userAgent,
    });
  }

  async register(input: RegisterInput, reqHeaders: NodeHeaders) {
    // Read before the config guard: a rejected attempt is audited too, and an audit row
    // with no origin is barely a record.
    const { ip, userAgent } = extractClientMeta(reqHeaders);
    const meta = { ip, userAgent };
    const registration = this.platformConfig?.registration;
    const provisioning = this.playerProvisioning;
    if (!registration || !provisioning) {
      this.emitRegistrationFailed('registration_disabled', input, meta);
      throw new ORPCError('FORBIDDEN', { message: 'Registration is unavailable' });
    }
    // `assertRateLimit` throws and is shared by a dozen call sites, so the emit wraps it
    // here rather than moving into it.
    try {
      await assertRateLimit(
        this.limiter,
        `register:${input.email.toLowerCase()}`,
        REGISTER_RATE_LIMIT,
      );
      await assertRateLimit(this.limiter, `register-ip:${ip ?? 'unknown'}`, REGISTER_RATE_LIMIT);
    } catch (err) {
      this.emitRegistrationFailed('rate_limited', input, meta);
      throw err;
    }
    if (this.geoCheck && !(await this.geoCheck.checkRegistration(ip)).allowed) {
      this.emitRegistrationFailed('geo_blocked', input, meta);
      throw new ORPCError('FORBIDDEN', { message: 'Registration is unavailable' });
    }
    const headers = nodeHeadersToHeaders(reqHeaders);
    const authResponse = await this.api.signUpEmail({
      body: {
        email: input.email,
        password: input.password,
        name: input.username,
        username: input.username,
      },
      headers,
      asResponse: true,
    });
    if (!authResponse.ok) {
      // The `lower(username)` unique index is the only arbiter - a pre-flight check
      // could not close the race anyway, so the taken handle is read off the failure.
      if (await this.findUserIdByUsername(input.username)) {
        this.emitRegistrationFailed('username_taken', input, meta);
        throw new UsernameConflictError();
      }
      // `ensureOk` always throws on a non-ok response, so emitting first needs no catch.
      this.emitRegistrationFailed('error', input, meta);
      await ensureOk(authResponse, { genericMessage: 'Registration is unavailable' });
    }
    const body = (await authResponse.json()) as { user: BetterAuthUser };
    // A known address gets an indistinguishable success response (and a reset mail)
    // rather than a new account, so only a genuinely new user is provisioned.
    if ((await this.findUserIdByEmail(input.email)) !== body.user.id) {
      // The known-address branch: no account was created, so the attempt failed even
      // though the caller is told it succeeded. Only the audit trail says so.
      this.emitRegistrationFailed('email_already_registered', input, meta);
      return { status: 'check-email' as const };
    }
    let consent: Awaited<ReturnType<IdentityService['recordRegistrationConsent']>>;
    try {
      consent = await this.recordRegistrationConsent(
        provisioning,
        body.user.id,
        registration.termsVersion,
        { ip, userAgent },
      );
    } catch (err) {
      this.emitRegistrationFailed('error', input, meta);
      throw err;
    }
    const { playerId, consentStored } = consent;
    // After the consent write, which is what materialises the player row the zone lands on.
    // No session yet, but the browser is here now and a first login may be days away.
    await captureTimezone(this.playerProvisioning, body.user.id, input.timezone);
    this.events.emit('identity.user.registered', {
      userId: body.user.id,
      playerId: playerId ?? (await this.identityReader.getPlayerIdByUserIdSafe(body.user.id)),
      // Only claimed when the consent row was actually written - a discarded capture
      // must not leave an audit trail implying evidence that does not exist.
      ...(consentStored
        ? {
            termsVersion: registration.termsVersion,
            acceptedTerms: input.acceptedTerms,
            acceptedAge: input.acceptedAge,
          }
        : {}),
      ip,
      userAgent,
    });
    // Sent here rather than by better-auth's sendOnSignUp hook: that hook also fires on
    // the synthetic duplicate-email response, mailing a live code to an address whose
    // owner never asked for it - and `verifyEmail` signs that code's bearer in.
    // A mail failure is logged, never surfaced: the account exists either way and the
    // player can ask for a new code, so failing the call here would only mislead them.
    const otpResponse = await this.api.sendVerificationOTP({
      body: { email: input.email, type: 'email-verification' },
      headers,
      asResponse: true,
    });
    if (!otpResponse.ok) {
      identityLogger.error(
        { userId: body.user.id, status: otpResponse.status },
        'verification code could not be sent - player must request a new one',
      );
    }
    return { status: 'check-email' as const };
  }

  private async findUserIdByUsername(username: string) {
    const [row] = await this.drizzle.db
      .select({ id: user.id })
      .from(user)
      .where(eq(sql`lower(${user.username})`, username.toLowerCase()))
      .limit(1);
    return row?.id ?? null;
  }

  private async findUserIdByEmail(email: string) {
    const [row] = await this.drizzle.db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, email.toLowerCase()))
      .limit(1);
    return row?.id ?? null;
  }

  /**
   * Better Auth commits the user inside its own transaction before returning, so a
   * failure here would otherwise leave an account with no consent record. The user is
   * deleted instead (sessions and accounts cascade), making registration all-or-nothing.
   */
  private async recordRegistrationConsent(
    provisioning: PlayerProvisioning,
    userId: User['id'],
    termsVersion: string,
    { ip, userAgent }: ClientMeta,
  ) {
    const now = new Date();
    let outcome: Awaited<ReturnType<PlayerProvisioning['createForRegistration']>>;
    try {
      outcome = await provisioning.createForRegistration({
        userId,
        termsVersion,
        termsAcceptedAt: now,
        ageAcceptedAt: now,
        registrationIp: ip,
        registrationUserAgent: userAgent,
      });
    } catch (err) {
      identityLogger.error(
        { err, userId },
        'registration consent write failed - rolling back user',
      );
      await this.drizzle.db.delete(user).where(eq(user.id, userId));
      throw new ORPCError('INTERNAL_SERVER_ERROR', { message: 'Registration is unavailable' });
    }
    if (!outcome.created) {
      // A player row already existed, so this consent capture was discarded. Never
      // silent: the acceptance evidence is a compliance record.
      identityLogger.error(
        { userId, termsVersion },
        'registration consent not stored - player row already existed',
      );
    }
    return { playerId: outcome.playerId ?? null, consentStored: outcome.created };
  }

  async usernameAvailable(username: string, reqHeaders: NodeHeaders) {
    const { ip } = extractClientMeta(reqHeaders);
    await assertRateLimit(
      this.limiter,
      `check-username:${ip ?? 'unknown'}`,
      USERNAME_AVAILABILITY_RATE_LIMIT,
    );
    return { available: !(await this.findUserIdByUsername(username)) };
  }

  /**
   * Credentials are verified FIRST; the RG login block is checked only AFTER
   * a pass, so a pre-auth probe can't distinguish a restricted account from a
   * wrong password. An RG-blocked account still authenticates then has its
   * fresh session immediately expired and the cookie withheld - it never
   * counts toward the lockout budget. A 2FA-enrolled account returns
   * `{ twoFactorRedirect: true }` instead of a session; the client completes
   * via `verifyTwoFactor`. Failed-attempt counting only advances on a genuine
   * credential rejection (never on a transient/backend error), via an atomic
   * `UPDATE ... SET attempts = attempts + 1` so concurrent failures can't each
   * read a stale count and slip past the lockout threshold.
   */
  async login(input: LoginInput, reqHeaders: NodeHeaders, resHeaders: Headers) {
    const { ip, userAgent } = extractClientMeta(reqHeaders);
    const headers = nodeHeadersToHeaders(reqHeaders);
    // better-auth lowercases emails on write, so the lockout lookup must match on the same form.
    const email = input.email.toLowerCase();

    await assertRateLimit(this.limiter, makeLoginRateLimitKey(email), LOGIN_RATE_LIMIT);

    const configLockoutEnabled = this.options?.lockout?.enabled ?? true;
    // Read once for the lockout budget, the admin-bypass check, and the RG login gate
    // (indexed email lookup). Read unconditionally - the RG gate runs even when lockout
    // is disabled.
    const [existingUserRow] = await this.drizzle.db
      .select({
        id: user.id,
        failedLoginAttempts: user.failedLoginAttempts,
        lockoutUntil: user.lockoutUntil,
        lockoutCount: user.lockoutCount,
        lastLockoutAt: user.lastLockoutAt,
        lastFailedLoginAt: user.lastFailedLoginAt,
        role: user.role,
        rgBlocked: user.rgBlocked,
        rgBlockedUntil: user.rgBlockedUntil,
      })
      .from(user)
      .where(eq(user.email, email))
      .limit(1);
    let existingUser:
      | Pick<
          typeof user.$inferSelect,
          | 'id'
          | 'failedLoginAttempts'
          | 'lockoutUntil'
          | 'lockoutCount'
          | 'lastLockoutAt'
          | 'lastFailedLoginAt'
          | 'role'
          | 'rgBlocked'
          | 'rgBlockedUntil'
        >
      | undefined = existingUserRow;

    const isAdmin = existingUser?.role === 'admin';
    const bypassForAdmins = this.options?.lockout?.bypassForAdmins ?? false;
    const lockoutEnabled = configLockoutEnabled && !(isAdmin && bypassForAdmins);

    const nowMs = Date.now();
    if (lockoutEnabled && existingUser?.lockoutUntil) {
      if (new Date(existingUser.lockoutUntil) > new Date(nowMs)) {
        throw createAccountLockedError(new Date(existingUser.lockoutUntil));
      }
      // Lock window elapsed: clear it so the next failure starts from a fresh budget
      // instead of one more wrong password immediately re-locking the account.
      await this.clearLockout(existingUser.id);
      existingUser = { ...existingUser, failedLoginAttempts: 0, lockoutUntil: null };
    }

    if (
      lockoutEnabled &&
      existingUser &&
      hasFailedLoginWindowExpired(existingUser.lastFailedLoginAt, existingUser.lastLockoutAt, nowMs)
    ) {
      await this.resetLockoutTier(existingUser.id);
      existingUser = {
        ...existingUser,
        failedLoginAttempts: 0,
        lockoutUntil: null,
        lockoutCount: 0,
        lastLockoutAt: null,
        lastFailedLoginAt: null,
      };
    }

    let fakeLoginShadow: FakeLoginShadow | undefined;
    if (lockoutEnabled && !existingUser) {
      fakeLoginShadow = await this.loginShadowGet(loginShadowKey(email));
      if (fakeLoginShadow?.lastFailedLoginAt) {
        const lastFailedLoginAt = new Date(fakeLoginShadow.lastFailedLoginAt);
        if (hasFailedLoginWindowExpired(lastFailedLoginAt, null, nowMs)) {
          fakeLoginShadow = {
            failedAttempts: 0,
            lockoutUntil: null,
            lockoutCount: 0,
            lastLockoutAt: null,
            lastFailedLoginAt: null,
          };
        }
      }
      if (fakeLoginShadow?.lockoutUntil) {
        if (new Date(fakeLoginShadow.lockoutUntil) > new Date()) {
          throw createAccountLockedError(new Date(fakeLoginShadow.lockoutUntil));
        }
        fakeLoginShadow = { ...fakeLoginShadow, failedAttempts: 0, lockoutUntil: null };
      }
    }

    // better-auth honours its trust-device cookie on its own and offers no way to revoke
    // one. The revocable half of a trusted device is the row this module keeps, so a login
    // presenting the cookie without a live row has to fall back to the full challenge.
    let signInHeaders = headers;
    if (existingUser && this.trustedDevices && hasTrustDeviceCookie(headers)) {
      const trusted = await this.trustedDevices.isTrusted(existingUser.id, userAgent);
      if (!trusted) {
        signInHeaders = withoutTrustDeviceCookie(headers);
      }
    }

    try {
      const authResponse = await this.auth.api.signInEmail({
        body: { email, password: input.password, rememberMe: input.rememberMe },
        headers: signInHeaders,
        asResponse: true,
      });
      await ensureOk(authResponse);

      // RG and backoffice blocks, applied only AFTER credentials verify so a pre-auth
      // probe can't distinguish a restricted account from a wrong password. Resolves
      // playerId once, so the eventual login success event can carry it too.
      const playerId = existingUser
        ? await this.assertAccountNotBlocked(existingUser, { ip, userAgent })
        : null;

      this.forwardCookies(authResponse, resHeaders);

      const body = (await authResponse.json()) as {
        user?: BetterAuthUser;
        token?: string;
        session?: { expiresAt: string | Date };
        twoFactorRedirect?: boolean;
      };

      if (body.twoFactorRedirect || !body.user || !body.token) {
        return { twoFactorRedirect: true };
      }

      if (lockoutEnabled && existingUser) {
        await this.clearLockout(existingUser.id);
      }

      await this.drizzle.db
        .update(session)
        .set({ ipAddress: ip, userAgent })
        .where(eq(session.token, body.token));
      this.events.emit('identity.user.login', {
        userId: body.user.id,
        playerId,
        ip,
        userAgent,
      });
      await captureTimezone(this.playerProvisioning, body.user.id, input.timezone);
      const sessionDurationSeconds =
        this.auth.options.session?.expiresIn ?? SESSION_DURATION_IN_SECONDS;
      const expiresAt = body.session?.expiresAt
        ? toIso(body.session.expiresAt)
        : new Date(Date.now() + sessionDurationSeconds * 1000).toISOString();
      return {
        user: toUser(body.user),
        session: { token: body.token, expiresAt },
        security: makeLoginSecurityState({
          failedLoginAttempts: 0,
          maxAttempts: this.options?.lockout?.maxAttempts ?? DEFAULT_MAX_LOGIN_ATTEMPTS,
          lockoutUntil: null,
        }),
      };
    } catch (error) {
      // An RG block is not a credential failure - surface it as-is, without touching the
      // lockout budget or emitting login.failed (the RG event was already emitted). Match on
      // the RG_BLOCKED marker, not the bare FORBIDDEN code - ensureOk also maps a banned-user
      // 403 (better-auth's admin plugin) to FORBIDDEN, and that path must still fall through
      // to the generic branch below to emit login.failed.
      if (
        error instanceof ORPCError &&
        error.code === 'FORBIDDEN' &&
        (hasErrorCode(error, 'RG_BLOCKED') || hasErrorCode(error, 'ACCOUNT_SUSPENDED'))
      ) {
        throw error;
      }
      // Only a genuine credential rejection counts toward lockout - a transient DB/network
      // error must never lock the account out.
      const isAccountLocked =
        error instanceof ORPCError &&
        error.code === 'UNAUTHORIZED' &&
        hasErrorCode(error, 'ACCOUNT_LOCKED');
      const isCredentialFailure =
        error instanceof ORPCError && error.code === 'UNAUTHORIZED' && !isAccountLocked;

      let attemptsRemaining: number | undefined;
      if (lockoutEnabled && existingUser && isCredentialFailure) {
        const maxAttempts = this.options?.lockout?.maxAttempts ?? DEFAULT_MAX_LOGIN_ATTEMPTS;
        const fallbackDurationMs = this.options?.lockout?.durationMs ?? DEFAULT_LOCKOUT_DURATION_MS;
        // Atomic increment: concurrent failures can't each read a stale count and slip past
        // the threshold (the read-modify-write this replaces was bypassable under load).
        const [row] = await this.drizzle.db
          .update(user)
          .set({
            failedLoginAttempts: sql`${user.failedLoginAttempts} + 1`,
            lastFailedLoginAt: new Date(),
          })
          .where(eq(user.id, existingUser.id))
          .returning({ failedLoginAttempts: user.failedLoginAttempts });
        const newAttempts = row?.failedLoginAttempts ?? existingUser.failedLoginAttempts + 1;
        attemptsRemaining = Math.max(maxAttempts - newAttempts, 0);
        const { isLocking } = computeLockoutState({
          attempts: newAttempts,
          maxAttempts,
          durationMs: fallbackDurationMs,
          nowMs: Date.now(),
        });

        if (isLocking) {
          const nowMs = Date.now();
          // Escalate the lockout duration for repeat offenders inside the 24h window.
          const { tier, durationMs } = computeLockoutTier({
            lockoutCount: existingUser.lockoutCount ?? 0,
            lastFailedLoginAt: existingUser.lastFailedLoginAt ?? null,
            fallbackLastLockoutAt: existingUser.lastLockoutAt ?? null,
            nowMs,
            fallbackDurationMs,
          });
          const lockoutUntil = new Date(nowMs + durationMs);
          const [lockoutRow] = await this.drizzle.db
            .update(user)
            .set({ lockoutUntil, lockoutCount: tier, lastLockoutAt: new Date(nowMs) })
            // Only the first request that reaches the threshold creates the lockout.
            // Other concurrent failures must observe and return the winner's lockout
            // instead of overwriting its tier or emitting a duplicate event.
            .where(and(eq(user.id, existingUser.id), isNull(user.lockoutUntil)))
            .returning({ lockoutUntil: user.lockoutUntil });

          if (!lockoutRow) {
            const [current] = await this.drizzle.db
              .select({ lockoutUntil: user.lockoutUntil })
              .from(user)
              .where(eq(user.id, existingUser.id))
              .limit(1);
            if (current?.lockoutUntil) {
              throw createAccountLockedError(current.lockoutUntil);
            }
            throw new ORPCError('INTERNAL_SERVER_ERROR', {
              message: 'Unable to establish account lockout.',
            });
          }

          await this.limiter?.reset(makeLoginRateLimitKey(email));

          this.events.emit('identity.user.lockout.triggered', {
            userId: existingUser.id,
            email,
            tier,
            lockoutUntil: lockoutUntil.toISOString(),
            ip,
            userAgent,
          });

          throw createAccountLockedError(lockoutUntil);
        }
      } else if (lockoutEnabled && !existingUser && isCredentialFailure) {
        const maxAttempts = this.options?.lockout?.maxAttempts ?? DEFAULT_MAX_LOGIN_ATTEMPTS;
        const fallbackDurationMs = this.options?.lockout?.durationMs ?? DEFAULT_LOCKOUT_DURATION_MS;
        const newAttempts = (fakeLoginShadow?.failedAttempts ?? 0) + 1;
        attemptsRemaining = Math.max(maxAttempts - newAttempts, 0);
        const { isLocking } = computeLockoutState({
          attempts: newAttempts,
          maxAttempts,
          durationMs: fallbackDurationMs,
          nowMs: Date.now(),
        });

        if (isLocking) {
          const nowMs = Date.now();
          const { tier, durationMs } = computeLockoutTier({
            lockoutCount: fakeLoginShadow?.lockoutCount ?? 0,
            lastFailedLoginAt: fakeLoginShadow?.lastFailedLoginAt
              ? new Date(fakeLoginShadow.lastFailedLoginAt)
              : null,
            fallbackLastLockoutAt: fakeLoginShadow?.lastLockoutAt
              ? new Date(fakeLoginShadow.lastLockoutAt)
              : null,
            nowMs,
            fallbackDurationMs,
          });
          const lockoutUntil = new Date(nowMs + durationMs);
          await this.loginShadowSet(loginShadowKey(email), {
            failedAttempts: newAttempts,
            lockoutUntil: lockoutUntil.toISOString(),
            lockoutCount: tier,
            lastLockoutAt: new Date(nowMs).toISOString(),
            lastFailedLoginAt: new Date(nowMs).toISOString(),
          });

          await this.limiter?.reset(makeLoginRateLimitKey(email));

          throw createAccountLockedError(lockoutUntil);
        }

        await this.loginShadowSet(loginShadowKey(email), {
          failedAttempts: newAttempts,
          lockoutUntil: null,
          lockoutCount: fakeLoginShadow?.lockoutCount ?? 0,
          lastLockoutAt: fakeLoginShadow?.lastLockoutAt ?? null,
          lastFailedLoginAt: new Date().toISOString(),
        });
      }

      const reason = isCredentialFailure ? 'invalid_credentials' : 'error';
      this.events.emit('identity.user.login.failed', {
        email,
        reason,
        ip,
        userAgent,
        ...(attemptsRemaining !== undefined ? { attemptsRemaining } : {}),
      });
      if (isCredentialFailure && error instanceof ORPCError && attemptsRemaining !== undefined) {
        const maxAttempts = this.options?.lockout?.maxAttempts ?? DEFAULT_MAX_LOGIN_ATTEMPTS;
        const security = makeLoginSecurityState({
          failedLoginAttempts:
            attemptsRemaining === undefined ? 0 : maxAttempts - attemptsRemaining,
          maxAttempts,
          lockoutUntil: null,
        });
        throw new ORPCError('UNAUTHORIZED', {
          message: error.message,
          data: { ...error.data, ...security },
        });
      }
      throw error;
    }
  }

  private clearLockout(userId: User['id']) {
    return this.drizzle.db
      .update(user)
      .set({ failedLoginAttempts: 0, lockoutUntil: null })
      .where(eq(user.id, userId));
  }

  private resetLockoutTier(userId: User['id']) {
    return this.drizzle.db
      .update(user)
      .set({
        failedLoginAttempts: 0,
        lockoutUntil: null,
        lockoutCount: 0,
        lastLockoutAt: null,
        lastFailedLoginAt: null,
      })
      .where(eq(user.id, userId));
  }

  private async loginShadowGet(key: string): Promise<FakeLoginShadow | undefined> {
    if (!this.cache) {
      return undefined;
    }
    try {
      return await this.cache.get<FakeLoginShadow>(key);
    } catch (err) {
      loginShadowLogger.warn({ key, err }, 'login shadow cache read failed');
      return undefined;
    }
  }

  private async loginShadowSet(key: string, value: FakeLoginShadow): Promise<void> {
    if (!this.cache) {
      return;
    }
    try {
      await this.cache.set(key, value, { ttlMs: FAKE_LOGIN_SHADOW_TTL_MS });
    } catch (err) {
      loginShadowLogger.warn({ key, err }, 'login shadow cache write failed');
    }
  }

  // Read by a downstream custom EmailTemplateRenderer (same CACHE binding) to tell an
  // admin-triggered reset apart from a self-service one within the synchronous
  // sendVerificationOTP -> templateRenderer.render call chain below.
  private adminPasswordResetMarkerKey(email: string): string {
    return `admin-password-reset:${email.toLowerCase()}`;
  }

  async adminRequestPasswordReset(userId: User['id'], actorId: User['id'], meta?: ClientMeta) {
    const existingUser = findOneOrThrow(
      await this.drizzle.db
        .select({ id: user.id, email: user.email })
        .from(user)
        .where(eq(user.id, userId))
        .limit(1),
      new UserNotFoundError(userId),
    );
    const email = existingUser.email.toLowerCase();

    try {
      await this.cache?.set(this.adminPasswordResetMarkerKey(email), true, { ttlMs: 120_000 });
    } catch (err) {
      identityLogger.warn({ email, err }, 'admin password reset marker cache write failed');
    }

    // Mirrors requestPasswordReset: the OTP email (if any) is delivered through the
    // sendEmail hook -> notifications; any underlying error is swallowed the same way.
    try {
      await this.api.requestPasswordResetEmailOTP({
        body: { email },
        headers: new Headers(),
        asResponse: true,
      });
    } catch {
      // intentionally ignored
    }

    this.events.emit('identity.password.admin_reset_requested', {
      userId,
      email,
      actorId,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    });

    return SUCCESS;
  }

  async unlockUser(userId: User['id'], actorId: User['id'], meta?: ClientMeta) {
    const existingUser = findOneOrThrow(
      await this.drizzle.db
        .select({
          id: user.id,
          email: user.email,
          failedLoginAttempts: user.failedLoginAttempts,
          lockoutUntil: user.lockoutUntil,
        })
        .from(user)
        .where(eq(user.id, userId))
        .limit(1),
      new UserNotFoundError(userId),
    );

    await this.clearLockout(userId);
    await this.limiter?.reset(makeLoginRateLimitKey(existingUser.email));

    this.events.emit('identity.user.unlocked', {
      userId,
      email: existingUser.email,
      actorId,
      previousFailedAttempts: existingUser.failedLoginAttempts,
      previousLockoutUntil: existingUser.lockoutUntil
        ? existingUser.lockoutUntil.toISOString()
        : null,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    });

    return SUCCESS;
  }

  async logout(reqHeaders: NodeHeaders, resHeaders: Headers) {
    const { ip, userAgent } = extractClientMeta(reqHeaders);
    const headers = nodeHeadersToHeaders(reqHeaders);
    // Resolve the user BEFORE signOut so the audit log can attribute the logout.
    const session = await this.auth.api.getSession({ headers });
    const userId = (session?.user as BetterAuthUser | undefined)?.id;
    const authResponse = await this.auth.api.signOut({ headers, asResponse: true });
    this.forwardCookies(authResponse, resHeaders);
    if (userId) {
      this.events.emit('identity.user.logout', {
        userId,
        playerId: await this.identityReader.getPlayerIdByUserIdSafe(userId),
        ip,
        userAgent,
      });
    }
    return SUCCESS;
  }

  async me(reqHeaders: NodeHeaders) {
    const headers = nodeHeadersToHeaders(reqHeaders);
    const session = await this.auth.api.getSession({ headers });
    if (!session?.user) {
      return null;
    }
    return toUser(session.user as BetterAuthUser);
  }

  async enableTwoFactor(input: Enable2faInput, reqHeaders: NodeHeaders, resHeaders: Headers) {
    const headers = nodeHeadersToHeaders(reqHeaders);
    const userId = await this.currentUserId(headers);
    await assertRateLimit(
      this.limiter,
      `enable2fa:${userId ?? 'anonymous'}`,
      TWO_FACTOR_PASSWORD_RATE_LIMIT,
    );
    const res = await this.api.enableTwoFactor({
      body: { password: input.password },
      headers,
      asResponse: true,
    });
    await ensureOk(res);
    this.forwardCookies(res, resHeaders);
    const body = (await res.json()) as { totpURI: string; backupCodes: string[] };
    return { totpUri: body.totpURI, backupCodes: body.backupCodes };
  }

  async verifyTwoFactor(input: Verify2faInput, reqHeaders: NodeHeaders, resHeaders: Headers) {
    const { ip, userAgent } = extractClientMeta(reqHeaders);
    const headers = nodeHeadersToHeaders(reqHeaders);
    const pendingCookie = twoFactorPendingCookieValue(headers);
    const sessionUserId = await this.currentUserId(headers);
    const twoFactorKey = sessionUserId ?? pendingCookie ?? 'anonymous';
    await assertRateLimit(this.limiter, `verify2fa:${twoFactorKey}`, VERIFY_2FA_RATE_LIMIT);

    const challengedUserId =
      sessionUserId ?? (await this.twoFactorLockout?.resolvePendingUserId(pendingCookie));
    if (challengedUserId) {
      await this.twoFactorLockout?.assertNotLocked(challengedUserId);
    }

    // A backup code is a single-use recovery credential, not a second factor to bind a
    // browser to: it clears the challenge but never buys the trust window.
    const trustDevice =
      input.trustDevice && input.method === 'totp' && this.trustedDevices !== undefined;
    const body = { code: input.code, trustDevice };
    const res =
      input.method === 'backup_code'
        ? await this.api.verifyBackupCode({ body, headers, asResponse: true })
        : await this.api.verifyTOTP({ body, headers, asResponse: true });
    if (!res.ok && challengedUserId) {
      await this.twoFactorLockout?.recordFailure(challengedUserId, { ip, userAgent });
    }
    await ensureOk(res);
    if (challengedUserId) {
      await this.twoFactorLockout?.reset(challengedUserId);
    }
    this.forwardCookies(res, resHeaders);
    // better-auth rotates the session on a successful challenge, so the request cookie is
    // already dead here - the actor is the identity resolved before the call.
    const userId = challengedUserId ?? (await this.currentUserId(headers));
    if (userId) {
      const playerId = await this.identityReader.getPlayerIdByUserIdSafe(userId);
      // A challenge answered from a live session is the enrolment step: better-auth only
      // flips twoFactorEnabled once the first code clears. Every later verification is a
      // sign-in, which carries the pending cookie instead and must not re-announce setup.
      if (sessionUserId) {
        this.events.emit('identity.2fa.enabled', {
          userId,
          playerId,
          method: input.method,
          ip,
          userAgent,
        });
      }
      this.events.emit('identity.2fa.verified', {
        userId,
        playerId,
        method: input.method,
        trustedDevice: trustDevice,
        ip,
        userAgent,
      });
      if (trustDevice) {
        await this.trustedDevices?.trust(userId, { ip, userAgent });
      }
      await captureTimezone(this.playerProvisioning, userId, input.timezone);
    }
    return SUCCESS;
  }

  /**
   * Grants this browser its trust window without a sign-out. better-auth issues the
   * trust cookie only on the sign-in leg of a challenge, so the grant has to replay
   * that leg: the account proves its password and a fresh second factor, and the
   * cookies better-auth returns are the ones the browser keeps.
   */
  async trustCurrentDevice(
    input: TrustCurrentDeviceInput,
    reqHeaders: NodeHeaders,
    resHeaders: Headers,
  ) {
    const { ip, userAgent } = extractClientMeta(reqHeaders);
    const headers = nodeHeadersToHeaders(reqHeaders);
    const userId = await this.currentUserId(headers);
    if (!userId) {
      throw new ORPCError('UNAUTHORIZED', { message: 'Not signed in' });
    }
    await assertRateLimit(this.limiter, `trustDevice:${userId}`, TWO_FACTOR_PASSWORD_RATE_LIMIT);

    const [account] = await this.drizzle.db
      .select({ email: user.email })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    if (!account) {
      throw new UserNotFoundError(userId);
    }

    const signIn = await this.auth.api.signInEmail({
      body: { email: account.email, password: input.password },
      headers: withoutTrustDeviceCookie(headers),
      asResponse: true,
    });
    await ensureOk(signIn);
    const signInBody = (await signIn.json()) as { twoFactorRedirect?: boolean };
    if (signInBody.twoFactorRedirect !== true) {
      throw new ORPCError('BAD_REQUEST', {
        message: 'Two-factor authentication is not enabled for this account',
      });
    }

    // Only the cookies the challenge just issued: leaving the live session cookie in
    // place makes better-auth treat the call as a settings change and skip the trust.
    const challengeHeaders = new Headers(headers);
    challengeHeaders.set('cookie', requestCookieHeader(signIn));

    await this.twoFactorLockout?.assertNotLocked(userId);

    // Only a live authenticator earns the trust window - a backup code is a recovery
    // credential and the schema never lets one reach this route.
    const verified = await this.api.verifyTOTP({
      body: { code: input.code, trustDevice: true },
      headers: challengeHeaders,
      asResponse: true,
    });
    if (!verified.ok) {
      await this.twoFactorLockout?.recordFailure(userId, { ip, userAgent });
    }
    await ensureOk(verified);
    await this.twoFactorLockout?.reset(userId);

    this.forwardCookies(verified, resHeaders);
    await this.trustedDevices?.trust(userId, { ip, userAgent });
    this.events.emit('identity.2fa.verified', {
      userId,
      playerId: await this.identityReader.getPlayerIdByUserIdSafe(userId),
      method: 'totp',
      trustedDevice: true,
      ip,
      userAgent,
    });
    return SUCCESS;
  }

  /**
   * A step-up gate for the self-service routes that change standing 2FA state: the
   * caller has to clear a live authenticator code, not just the account password.
   * Routed through TwoFactorLockoutService so a hijacked session plus a reused
   * password cannot grind the second factor here the way the password-only paths let it.
   */
  private async assertFreshSecondFactor(
    userId: User['id'],
    headers: Headers,
    meta: ClientMeta,
    code: string,
  ): Promise<void> {
    await this.twoFactorLockout?.assertNotLocked(userId);
    const res = await this.api.verifyTOTP({
      body: { code, trustDevice: false },
      headers,
      asResponse: true,
    });
    if (!res.ok) {
      await this.twoFactorLockout?.recordFailure(userId, meta);
    }
    await ensureOk(res, { genericMessage: 'Invalid authenticator code' });
    await this.twoFactorLockout?.reset(userId);
  }

  async regenerateBackupCodes(
    input: RegenerateBackupCodesInput,
    reqHeaders: NodeHeaders,
    resHeaders: Headers,
  ) {
    const { ip, userAgent } = extractClientMeta(reqHeaders);
    const headers = nodeHeadersToHeaders(reqHeaders);
    const userId = await this.currentUserId(headers);
    await assertRateLimit(
      this.limiter,
      `backupCodes:${userId ?? 'anonymous'}`,
      TWO_FACTOR_PASSWORD_RATE_LIMIT,
    );
    if (!userId) {
      throw new ORPCError('UNAUTHORIZED', { message: 'Not signed in' });
    }
    await this.assertFreshSecondFactor(userId, headers, { ip, userAgent }, input.code);

    const res = await this.api.generateBackupCodes({
      body: { password: input.password },
      headers,
      asResponse: true,
    });
    await ensureOk(res);
    this.forwardCookies(res, resHeaders);
    const body = (await res.json()) as { backupCodes: string[] };

    // The old set is void the moment a new one is minted, so any device still trusted
    // off the old recovery flow re-verifies on its next login.
    await this.trustedDevices?.revokeAllForUser(userId, userId);

    this.events.emit('identity.2fa.backup_codes_regenerated', {
      userId,
      playerId: await this.identityReader.getPlayerIdByUserIdSafe(userId),
      ip,
      userAgent,
    });
    return { backupCodes: body.backupCodes };
  }

  async disableTwoFactor(input: Disable2faInput, reqHeaders: NodeHeaders, resHeaders: Headers) {
    const { ip, userAgent } = extractClientMeta(reqHeaders);
    const headers = nodeHeadersToHeaders(reqHeaders);
    const userId = await this.currentUserId(headers);
    await assertRateLimit(
      this.limiter,
      `disable2fa:${userId ?? 'anonymous'}`,
      TWO_FACTOR_PASSWORD_RATE_LIMIT,
    );
    if (!userId) {
      throw new ORPCError('UNAUTHORIZED', { message: 'Not signed in' });
    }
    await this.assertFreshSecondFactor(userId, headers, { ip, userAgent }, input.code);

    const res = await this.api.disableTwoFactor({
      body: { password: input.password },
      headers,
      asResponse: true,
    });
    await ensureOk(res);
    this.forwardCookies(res, resHeaders);

    // Dropping the second factor takes every standing bypass with it, the same teardown
    // a Super Admin reset performs - a browser must not keep the access 2FA was guarding.
    await this.trustedDevices?.revokeAllForUser(userId, userId);
    await this.sessions?.revokeAllSessions(userId, userId, { ip, userAgent });

    this.events.emit('identity.2fa.disabled', {
      userId,
      playerId: await this.identityReader.getPlayerIdByUserIdSafe(userId),
      method: 'totp',
      ip,
      userAgent,
    });
    return SUCCESS;
  }

  async requestPasswordReset(input: RequestPasswordResetInput) {
    const email = input.email.toLowerCase();
    await assertRateLimit(
      this.limiter,
      makeRateLimitKey(RATE_LIMIT_KEYS.PASSWORD_RESET_REQUEST, email),
      PASSWORD_RESET_REQUEST_RATE_LIMIT,
    );
    // Always returns success - never reveal whether the email exists. The reset
    // email (if any) is delivered through the sendEmail hook -> notifications.
    // Any underlying error is swallowed for the same anti-enumeration reason.
    try {
      await this.api.requestPasswordResetEmailOTP({
        body: { email },
        headers: new Headers(),
        asResponse: true,
      });
    } catch {
      // intentionally ignored
    }
    return SUCCESS;
  }

  async verifyPasswordResetOtp(input: VerifyPasswordResetOtpInput) {
    const email = input.email.toLowerCase();
    await assertRateLimit(
      this.limiter,
      makeRateLimitKey(RATE_LIMIT_KEYS.PASSWORD_RESET_VERIFY, email),
      PASSWORD_RESET_VERIFY_RATE_LIMIT,
    );
    const res = await this.api.checkVerificationOTP({
      body: { email, type: 'forget-password', otp: input.otp },
      headers: new Headers(),
      asResponse: true,
    });
    await ensureOk(res, { genericMessage: 'Invalid or expired verification code' });
    return SUCCESS;
  }

  async resetPassword(input: ResetPasswordInput) {
    const email = input.email.toLowerCase();
    await assertRateLimit(
      this.limiter,
      makeRateLimitKey(RATE_LIMIT_KEYS.PASSWORD_RESET, email),
      PASSWORD_RESET_RATE_LIMIT,
    );
    const res = await this.api.resetPasswordEmailOTP({
      body: { email, otp: input.otp, password: input.newPassword },
      headers: new Headers(),
      asResponse: true,
    });
    await ensureOk(res, { genericMessage: 'Invalid or expired verification code' });

    // better-auth's resetPasswordEmailOTP internally invokes the onPasswordReset hook
    // (wired in the constructor above), which emits `identity.password.reset` and
    // clears the lockout - do not duplicate that here (was double-emitting/double-
    // clearing on every real reset).
    return SUCCESS;
  }

  async changePassword(input: ChangePasswordInput, reqHeaders: NodeHeaders, resHeaders: Headers) {
    const headers = nodeHeadersToHeaders(reqHeaders);
    const userId = await this.currentUserId(headers);
    await assertRateLimit(
      this.limiter,
      `change-password:${userId ?? 'anonymous'}`,
      CHANGE_PASSWORD_RATE_LIMIT,
    );
    const res = await this.api.changePassword({
      body: { currentPassword: input.currentPassword, newPassword: input.newPassword },
      headers,
      asResponse: true,
    });
    await ensureOk(res);
    this.forwardCookies(res, resHeaders);
    return SUCCESS;
  }

  /**
   * Resends the registration code. Unauthenticated by design - the player has no session
   * until the code is verified - so it answers SUCCESS for every address and only mails a
   * code to an account that exists and is still unverified. Verified accounts are skipped
   * deliberately: `verifyEmail` signs the code's bearer in, so resending to a verified
   * address would turn this into passwordless sign-in for anyone who can read that inbox.
   */
  async sendEmailVerification(input: ResendEmailVerificationInput, reqHeaders: NodeHeaders) {
    const { ip } = extractClientMeta(reqHeaders);
    const email = input.email.toLowerCase();
    await assertRateLimit(this.limiter, `email-verify:${email}`, EMAIL_VERIFICATION_RATE_LIMIT);
    if (ip) {
      await assertRateLimit(this.limiter, `email-verify-ip:${ip}`, EMAIL_VERIFICATION_RATE_LIMIT);
    }
    const [row] = await this.drizzle.db
      .select({ emailVerified: user.emailVerified })
      .from(user)
      .where(eq(user.email, email))
      .limit(1);
    if (row && !row.emailVerified) {
      await this.api.sendVerificationOTP({
        body: { email, type: 'email-verification' },
        headers: nodeHeadersToHeaders(reqHeaders),
        asResponse: true,
      });
    }
    return SUCCESS;
  }

  /**
   * Consumes the 6-digit code mailed by `register()` and signs the player in -
   * better-auth's `autoSignInAfterVerification` mints the session here rather than at
   * sign-up, which is what lets sign-up stay sessionless and therefore keep its
   * duplicate-email response indistinguishable. Same post-credential gates as `login`:
   * a code is proof of address ownership, not a bypass for an RG or backoffice block.
   */
  async verifyEmail(input: VerifyEmailInput, reqHeaders: NodeHeaders, resHeaders: Headers) {
    const { ip, userAgent } = extractClientMeta(reqHeaders);
    const headers = nodeHeadersToHeaders(reqHeaders);
    const email = input.email.toLowerCase();
    // Keyed on the address under attack (six digits are guessable) and on the caller, so
    // one client can neither grind a single account nor sweep many.
    await assertRateLimit(this.limiter, `verify-email:${email}`, VERIFY_EMAIL_RATE_LIMIT);
    // Only when the caller's IP is actually known: an `unknown` bucket would be shared by
    // every anonymous caller, letting one client stall everyone else's sign-up.
    if (ip) {
      await assertRateLimit(this.limiter, `verify-email-ip:${ip}`, VERIFY_EMAIL_RATE_LIMIT);
    }
    const res = await this.api.verifyEmailOTP({
      body: { email, otp: input.otp },
      headers,
      asResponse: true,
    });
    await ensureOk(res, { genericMessage: 'Invalid or expired verification code' });
    const body = (await res.json()) as { token?: string | null; user: BetterAuthUser };

    // better-auth has already committed `emailVerified` by now, so the audit record is
    // emitted before any gate below can throw - a state change that leaves no trail is a
    // compliance gap, see docs/standards/audit.md.
    const playerId = await this.identityReader.getPlayerIdByUserIdSafe(body.user.id);
    this.events.emit('identity.email.verified', { userId: body.user.id, playerId, ip, userAgent });

    const [account] = await this.drizzle.db
      .select({
        id: user.id,
        rgBlocked: user.rgBlocked,
        rgBlockedUntil: user.rgBlockedUntil,
        twoFactorEnabled: user.twoFactorEnabled,
      })
      .from(user)
      .where(eq(user.id, body.user.id))
      .limit(1);
    if (account) {
      await this.assertAccountNotBlocked(account, { ip, userAgent });
    }
    // Before the 2FA branch below: that path ends the session it just minted, but the zone
    // the browser reported is good either way.
    await captureTimezone(this.playerProvisioning, body.user.id, input.timezone);

    // better-auth mints this session with `createSession`, which its twoFactor plugin only
    // hooks on the sign-in routes - so an enrolled account would get a full session from
    // the emailed code alone, bypassing its second factor. Verification still stands; the
    // session does not, and the player signs in through `login` to face the challenge.
    if (account?.twoFactorEnabled) {
      // Scoped to the token this call just minted: the player's other devices did nothing
      // wrong, and an unrelated sign-out here would be indistinguishable from a session
      // hijack. The RG/backoffice branch above is the one that revokes everything.
      if (body.token) {
        await this.drizzle.db
          .update(session)
          .set({ expiresAt: new Date() })
          .where(eq(session.token, body.token));
      }
      return { twoFactorRedirect: true as const };
    }

    if (!body.token) {
      throw new ORPCError('INTERNAL_SERVER_ERROR', { message: 'Verification did not sign you in' });
    }
    this.forwardCookies(res, resHeaders);
    await this.drizzle.db
      .update(session)
      .set({ ipAddress: ip, userAgent })
      .where(eq(session.token, body.token));
    this.events.emit('identity.user.login', { userId: body.user.id, playerId, ip, userAgent });

    const sessionDurationSeconds =
      this.auth.options.session?.expiresIn ?? SESSION_DURATION_IN_SECONDS;
    return {
      user: toUser(body.user),
      session: {
        token: body.token,
        expiresAt: new Date(Date.now() + sessionDurationSeconds * 1000).toISOString(),
      },
    };
  }

  async changeEmail(input: ChangeEmailInput, reqHeaders: NodeHeaders, resHeaders: Headers) {
    const headers = nodeHeadersToHeaders(reqHeaders);
    const res = await this.api.changeEmail({
      body: { newEmail: input.newEmail },
      headers,
      asResponse: true,
    });
    await ensureOk(res);
    this.forwardCookies(res, resHeaders);
    return SUCCESS;
  }

  async updateProfile(input: UpdateProfileInput, reqHeaders: NodeHeaders, resHeaders: Headers) {
    if (input.language !== undefined) {
      assertSupportedLanguage(input.language, this.platformConfig);
    }
    const { ip, userAgent } = extractClientMeta(reqHeaders);
    const headers = nodeHeadersToHeaders(reqHeaders);
    // better-auth's field parser and drizzle's mapUpdateSet both drop `undefined`
    // values before the SQL SET clause, so omitted fields are safely no-ops here.
    const { name, image, theme, language } = input;
    const res = await this.api.updateUser({
      body: { name, image, theme, language },
      headers,
      asResponse: true,
    });
    await ensureOk(res);
    this.forwardCookies(res, resHeaders);
    // updateUser returns { status } only - re-read from session to get the full user.
    const session = await this.auth.api.getSession({ headers });
    const current = session?.user as BetterAuthUser | undefined;
    if (current) {
      this.events.emit('identity.profile.updated', {
        userId: current.id,
        playerId: await this.identityReader.getPlayerIdByUserIdSafe(current.id),
        ip,
        userAgent,
      });
    }
    if (!current) {
      throw new Error('Profile update succeeded but session could not be re-read');
    }
    return { user: toUser(current) };
  }
}

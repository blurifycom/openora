import { ORPCError } from '@orpc/server';
import {
  createAuth,
  type EventBus,
  type NodeHeaders,
  DrizzleService,
  assertRateLimit,
  findOneOrThrow,
  makeNotFoundError,
} from '@openora/core/server';
import { parseCookies } from 'better-auth/cookies';
import { eq, sql } from 'drizzle-orm';
import { user, session, account, verification, twoFactor } from '../schema/index.js';
import type {
  RateLimiterAdapter,
  RateLimitKey,
  SendEmailPort,
  LoginInput,
  RegisterInput,
  Enable2faInput,
  Verify2faInput,
  Disable2faInput,
  RequestPasswordResetInput,
  ResetPasswordInput,
  VerifyEmailInput,
  UpdateProfileInput,
  Theme,
  User,
  ChangePasswordInput,
  ChangeEmailInput,
  IdentityServiceOptions,
  PlatformConfig,
} from '@openora/core/contracts';
import { assertSupportedLanguage } from '../../shared/language.js';

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

export function createAccountLockedError(lockoutUntil: Date) {
  return new ORPCError('UNAUTHORIZED', {
    message: 'Account is temporarily locked. Please try again later.',
    data: {
      code: 'ACCOUNT_LOCKED',
      lockoutUntil: lockoutUntil.toISOString(),
    },
  });
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
    emailVerified: u.emailVerified,
    theme: u.theme ?? 'system',
    language: u.language ?? 'en',
    createdAt: toIso(u.createdAt),
    updatedAt: toIso(u.updatedAt),
  };
  return u.image !== undefined ? { ...base, image: u.image } : base;
}

function forwardCookies(authResponse: globalThis.Response, resHeaders: Headers): void {
  const cookies = authResponse.headers.getSetCookie?.() ?? [];
  for (const cookie of cookies) {
    resHeaders.append('set-cookie', cookie);
  }
}

function clientIp(headers: Headers): string | null {
  return headers.get('x-forwarded-for')?.split(',')[0]?.trim() || headers.get('x-real-ip') || null;
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
  enableTwoFactor: AuthCall<{ password: string }>;
  verifyTOTP: AuthCall<{ code: string }>;
  disableTwoFactor: AuthCall<{ password: string }>;
  requestPasswordReset: AuthCall<{ email: string; redirectTo?: string }>;
  resetPassword: AuthCall<{ newPassword: string; token: string }>;
  sendVerificationEmail: AuthCall<{ email: string }>;
  verifyEmail: AuthCall<{ token: string }>;
  changePassword: AuthCall<{ currentPassword: string; newPassword: string }>;
  changeEmail: AuthCall<{ newEmail: string }>;
  updateUser: AuthCall<{ name?: string; image?: string | null; theme?: Theme; language?: string }>;
};

const SUCCESS = { success: true as const };

export const UserNotFoundError = makeNotFoundError('User');

// better-auth calls use `asResponse: true`, which returns an error *Response*
// (4xx/5xx) rather than throwing. Surface those as ORPCErrors so oRPC maps them
// to the right HTTP status instead of the handler silently returning success.
// Only reads the body on failure, so a subsequent res.json() on success is safe.
async function ensureOk(res: globalThis.Response) {
  if (res.ok) {
    return;
  }
  let message = `Request failed (${res.status})`;
  try {
    const parsed = JSON.parse(await res.text()) as { message?: string };
    if (parsed.message) {
      message = parsed.message;
    }
  } catch {
    // non-JSON body - keep the default message
  }
  throw new ORPCError(res.status === 401 ? 'UNAUTHORIZED' : 'BAD_REQUEST', { message });
}

const DEFAULT_MAX_LOGIN_ATTEMPTS = 5;
const DEFAULT_LOCKOUT_DURATION_MS = 15 * 60 * 1000;

const MINUTE_MS = 60 * 1000;
// Coarse abuse throttles keyed by the caller identifier the context provides (email/
// token/session), NOT IP. The lockout above is a per-account credential-failure
// counter; these bound raw request volume on each brute-force surface. An overlay
// rebinds RATE_LIMITER to change the backend, not the policy - the numbers are here.
// Credential-guessing keys fail closed when the limiter backend is down: an
// unthrottled login/2fa/reset window is worse than a transient 429. The volume
// throttles (register/resend/etc.) keep the default fail-open.
const LOGIN_RATE_LIMIT = { limit: 10, windowMs: 5 * MINUTE_MS, onUnavailable: 'deny' } as const;
const REGISTER_RATE_LIMIT = { limit: 5, windowMs: 15 * MINUTE_MS };
const PASSWORD_RESET_REQUEST_RATE_LIMIT = { limit: 3, windowMs: 15 * MINUTE_MS };
const PASSWORD_RESET_RATE_LIMIT = {
  limit: 5,
  windowMs: 15 * MINUTE_MS,
  onUnavailable: 'deny',
} as const;
const VERIFY_2FA_RATE_LIMIT = { limit: 5, windowMs: 5 * MINUTE_MS, onUnavailable: 'deny' } as const;
const EMAIL_VERIFICATION_RATE_LIMIT = { limit: 3, windowMs: 15 * MINUTE_MS };
const VERIFY_EMAIL_RATE_LIMIT = { limit: 5, windowMs: 15 * MINUTE_MS };
const CHANGE_PASSWORD_RATE_LIMIT = { limit: 5, windowMs: 15 * MINUTE_MS };
const TWO_FACTOR_PASSWORD_RATE_LIMIT = { limit: 5, windowMs: 5 * MINUTE_MS };
// Mirrors better-auth session.expiresIn (server/auth/auth.ts); used only as a fallback
// when the sign-in response omits an explicit session expiry.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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

// A finite rgBlockedUntil in the past = a lapsed cooling-off; a null one = indefinite
// (self-exclusion / permanent). Blocked only while set and not elapsed.
function isRgBlocked(u: { rgBlocked: boolean; rgBlockedUntil: Date | null }): boolean {
  return u.rgBlocked && (u.rgBlockedUntil === null || u.rgBlockedUntil > new Date());
}

export type IdentityServiceDeps = {
  drizzle: DrizzleService;
  events: EventBus;
  email?: SendEmailPort;
  options?: IdentityServiceOptions;
  limiter?: RateLimiterAdapter<RateLimitKey>;
  platformConfig?: PlatformConfig;
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
  private readonly email?: SendEmailPort;
  private readonly options?: IdentityServiceOptions;
  private readonly limiter?: RateLimiterAdapter<RateLimitKey>;
  private readonly platformConfig?: PlatformConfig;

  constructor({ drizzle, events, email, options, limiter, platformConfig }: IdentityServiceDeps) {
    this.drizzle = drizzle;
    this.events = events;
    this.email = email;
    this.options = options;
    this.limiter = limiter;
    this.platformConfig = platformConfig;
    this.auth = createAuth({
      db: drizzle.db,
      schema: { user, session, account, verification, twoFactor },
      ...(email ? { sendEmail: (args) => email.send(args) } : {}),
    });
  }

  private get api() {
    // Library boundary: the admin/organization plugin endpoints aren't on better-auth's
    // base `api` type. Sanctioned cast, see conventions.
    return this.auth.api as unknown as ExtendedAuthApi;
  }

  private async currentUserId(headers: Headers) {
    const session = await this.auth.api.getSession({ headers });
    return session?.user?.id ?? null;
  }

  async register(input: RegisterInput, reqHeaders: NodeHeaders, resHeaders: Headers) {
    await assertRateLimit(
      this.limiter,
      `register:${input.email.toLowerCase()}`,
      REGISTER_RATE_LIMIT,
    );
    const headers = nodeHeadersToHeaders(reqHeaders);
    const authResponse = await this.auth.api.signUpEmail({
      body: { email: input.email, password: input.password, name: input.name },
      headers,
      asResponse: true,
    });
    forwardCookies(authResponse, resHeaders);
    const body = (await authResponse.json()) as { user: BetterAuthUser };

    this.events.emit('identity.user.registered', { userId: body.user.id });
    return { user: toUser(body.user) };
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
    const headers = nodeHeadersToHeaders(reqHeaders);
    const ip = clientIp(headers);
    const userAgent = headers.get('user-agent') || null;
    // better-auth lowercases emails on write, so the lockout lookup must match on the same form.
    const email = input.email.toLowerCase();

    await assertRateLimit(this.limiter, `login:${email}`, LOGIN_RATE_LIMIT);

    const configLockoutEnabled = this.options?.lockout?.enabled ?? true;
    // Read once for the lockout budget, the admin-bypass check, and the RG login gate
    // (indexed email lookup). Read unconditionally - the RG gate runs even when lockout
    // is disabled.
    const [existingUserRow] = await this.drizzle.db
      .select({
        id: user.id,
        failedLoginAttempts: user.failedLoginAttempts,
        lockoutUntil: user.lockoutUntil,
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
          'id' | 'failedLoginAttempts' | 'lockoutUntil' | 'role' | 'rgBlocked' | 'rgBlockedUntil'
        >
      | undefined = existingUserRow;

    const isAdmin = existingUser?.role === 'admin';
    const bypassForAdmins = this.options?.lockout?.bypassForAdmins ?? false;
    const lockoutEnabled = configLockoutEnabled && !(isAdmin && bypassForAdmins);

    if (lockoutEnabled && existingUser?.lockoutUntil) {
      if (new Date(existingUser.lockoutUntil) > new Date()) {
        throw createAccountLockedError(new Date(existingUser.lockoutUntil));
      }
      // Lock window elapsed: clear it so the next failure starts from a fresh budget
      // instead of one more wrong password immediately re-locking the account.
      await this.clearLockout(existingUser.id);
      existingUser = { ...existingUser, failedLoginAttempts: 0, lockoutUntil: null };
    }

    try {
      const authResponse = await this.auth.api.signInEmail({
        body: { email, password: input.password, rememberMe: input.rememberMe },
        headers,
        asResponse: true,
      });
      await ensureOk(authResponse);

      // RG login block, applied only AFTER credentials verify so a pre-auth probe can't
      // distinguish a restricted account from a wrong password. Kill the session
      // better-auth just issued and never forward its cookie. Cooling-off auto-expires
      // here once rgBlockedUntil elapses (no unblock job).
      if (existingUser && isRgBlocked(existingUser)) {
        await this.drizzle.db
          .update(session)
          .set({ expiresAt: new Date() })
          .where(eq(session.userId, existingUser.id));
        this.events.emit('rg.exclusion.login_blocked', { userId: existingUser.id, ip, userAgent });
        throw new ORPCError('FORBIDDEN', {
          message: 'Account access is currently restricted (responsible gambling).',
        });
      }

      forwardCookies(authResponse, resHeaders);
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

      this.events.emit('identity.user.login', { userId: body.user.id, ip, userAgent });
      const expiresAt = body.session?.expiresAt
        ? toIso(body.session.expiresAt)
        : new Date(Date.now() + SESSION_TTL_MS).toISOString();
      return {
        user: toUser(body.user),
        session: { token: body.token, expiresAt },
      };
    } catch (error) {
      // An RG block is not a credential failure - surface it as-is, without touching the
      // lockout budget or emitting login.failed (the RG event was already emitted).
      if (error instanceof ORPCError && error.code === 'FORBIDDEN') {
        throw error;
      }
      // Only a genuine credential rejection counts toward lockout - a transient DB/network
      // error must never lock the account out.
      const isCredentialFailure = error instanceof ORPCError && error.code === 'UNAUTHORIZED';

      if (lockoutEnabled && existingUser && isCredentialFailure) {
        const maxAttempts = this.options?.lockout?.maxAttempts ?? DEFAULT_MAX_LOGIN_ATTEMPTS;
        const durationMs = this.options?.lockout?.durationMs ?? DEFAULT_LOCKOUT_DURATION_MS;
        // Atomic increment: concurrent failures can't each read a stale count and slip past
        // the threshold (the read-modify-write this replaces was bypassable under load).
        const [row] = await this.drizzle.db
          .update(user)
          .set({ failedLoginAttempts: sql`${user.failedLoginAttempts} + 1` })
          .where(eq(user.id, existingUser.id))
          .returning({ failedLoginAttempts: user.failedLoginAttempts });
        const newAttempts = row?.failedLoginAttempts ?? existingUser.failedLoginAttempts + 1;
        const { isLocking, lockoutUntil } = computeLockoutState({
          attempts: newAttempts,
          maxAttempts,
          durationMs,
          nowMs: Date.now(),
        });

        if (isLocking && lockoutUntil) {
          await this.drizzle.db
            .update(user)
            .set({ lockoutUntil })
            .where(eq(user.id, existingUser.id));

          this.events.emit('identity.user.lockout.triggered', {
            userId: existingUser.id,
            email,
            lockoutUntil: lockoutUntil.toISOString(),
            ip,
            userAgent,
          });

          throw createAccountLockedError(lockoutUntil);
        }
      }

      const reason = isCredentialFailure ? 'invalid_credentials' : 'error';
      this.events.emit('identity.user.login.failed', { email, reason, ip, userAgent });
      throw error;
    }
  }

  private clearLockout(userId: User['id']) {
    return this.drizzle.db
      .update(user)
      .set({ failedLoginAttempts: 0, lockoutUntil: null })
      .where(eq(user.id, userId));
  }

  async unlockUser(userId: User['id'], actorId: User['id']) {
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
    await this.limiter?.reset(`login:${existingUser.email.toLowerCase()}`);

    this.events.emit('identity.user.unlocked', {
      userId,
      email: existingUser.email,
      actorId,
      previousFailedAttempts: existingUser.failedLoginAttempts,
      previousLockoutUntil: existingUser.lockoutUntil
        ? existingUser.lockoutUntil.toISOString()
        : null,
    });

    return SUCCESS;
  }

  async logout(reqHeaders: NodeHeaders, resHeaders: Headers) {
    const headers = nodeHeadersToHeaders(reqHeaders);
    // Resolve the user BEFORE signOut so the audit log can attribute the logout.
    const session = await this.auth.api.getSession({ headers });
    const userId = (session?.user as BetterAuthUser | undefined)?.id;
    const authResponse = await this.auth.api.signOut({ headers, asResponse: true });
    forwardCookies(authResponse, resHeaders);
    if (userId) {
      this.events.emit('identity.user.logout', { userId });
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
    forwardCookies(res, resHeaders);
    const body = (await res.json()) as { totpURI: string; backupCodes: string[] };
    return { totpUri: body.totpURI, backupCodes: body.backupCodes };
  }

  async verifyTwoFactor(input: Verify2faInput, reqHeaders: NodeHeaders, resHeaders: Headers) {
    const headers = nodeHeadersToHeaders(reqHeaders);
    const twoFactorKey =
      (await this.currentUserId(headers)) ?? twoFactorPendingCookieValue(headers) ?? 'anonymous';
    await assertRateLimit(this.limiter, `verify2fa:${twoFactorKey}`, VERIFY_2FA_RATE_LIMIT);
    const res = await this.api.verifyTOTP({
      body: { code: input.code },
      headers,
      asResponse: true,
    });
    await ensureOk(res);
    forwardCookies(res, resHeaders);
    const userId = await this.currentUserId(headers);
    if (userId) {
      this.events.emit('identity.2fa.enabled', { userId });
    }
    return SUCCESS;
  }

  async disableTwoFactor(input: Disable2faInput, reqHeaders: NodeHeaders, resHeaders: Headers) {
    const headers = nodeHeadersToHeaders(reqHeaders);
    const userId = await this.currentUserId(headers);
    await assertRateLimit(
      this.limiter,
      `disable2fa:${userId ?? 'anonymous'}`,
      TWO_FACTOR_PASSWORD_RATE_LIMIT,
    );
    const res = await this.api.disableTwoFactor({
      body: { password: input.password },
      headers,
      asResponse: true,
    });
    await ensureOk(res);
    forwardCookies(res, resHeaders);
    if (userId) {
      this.events.emit('identity.2fa.disabled', { userId });
    }
    return SUCCESS;
  }

  async requestPasswordReset(input: RequestPasswordResetInput) {
    await assertRateLimit(
      this.limiter,
      `pwreset-req:${input.email.toLowerCase()}`,
      PASSWORD_RESET_REQUEST_RATE_LIMIT,
    );
    // Always returns success - never reveal whether the email exists. The reset
    // email (if any) is delivered through the sendEmail hook -> notifications.
    // Any underlying error is swallowed for the same anti-enumeration reason.
    try {
      await this.api.requestPasswordReset({
        body: { email: input.email, redirectTo: '/reset-password' },
        headers: new Headers(),
        asResponse: true,
      });
    } catch {
      // intentionally ignored
    }
    return SUCCESS;
  }

  async resetPassword(input: ResetPasswordInput) {
    // Key on the token - the only identifier the input carries - to bound retries
    // against a single reset token.
    await assertRateLimit(this.limiter, `pwreset:${input.token}`, PASSWORD_RESET_RATE_LIMIT);
    const res = await this.api.resetPassword({
      body: { newPassword: input.newPassword, token: input.token },
      headers: new Headers(),
      asResponse: true,
    });
    await ensureOk(res);
    const body = (await res.json().catch(() => ({}))) as { user?: { id: string } };
    if (body.user?.id) {
      this.events.emit('identity.password.reset', { userId: body.user.id });
      // Password reset clears any lockout - the user has proven identity via email/phone.
      await this.clearLockout(body.user.id);
    }
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
    forwardCookies(res, resHeaders);
    return SUCCESS;
  }

  async sendEmailVerification(reqHeaders: NodeHeaders) {
    const headers = nodeHeadersToHeaders(reqHeaders);
    const session = await this.auth.api.getSession({ headers });
    const email = session?.user?.email;
    if (email) {
      await assertRateLimit(
        this.limiter,
        `email-verify:${email.toLowerCase()}`,
        EMAIL_VERIFICATION_RATE_LIMIT,
      );
      await this.api.sendVerificationEmail({ body: { email }, headers, asResponse: true });
    }
    return SUCCESS;
  }

  async verifyEmail(input: VerifyEmailInput, reqHeaders: NodeHeaders) {
    const headers = nodeHeadersToHeaders(reqHeaders);
    const userId = await this.currentUserId(headers);
    await assertRateLimit(
      this.limiter,
      `verify-email:${userId ?? 'anonymous'}`,
      VERIFY_EMAIL_RATE_LIMIT,
    );
    const res = await this.api.verifyEmail({
      query: { token: input.token },
      headers,
      asResponse: true,
    });
    await ensureOk(res);
    if (userId) {
      this.events.emit('identity.email.verified', { userId });
    }
    return SUCCESS;
  }

  async changeEmail(input: ChangeEmailInput, reqHeaders: NodeHeaders, resHeaders: Headers) {
    const headers = nodeHeadersToHeaders(reqHeaders);
    const res = await this.api.changeEmail({
      body: { newEmail: input.newEmail },
      headers,
      asResponse: true,
    });
    await ensureOk(res);
    forwardCookies(res, resHeaders);
    return SUCCESS;
  }

  async updateProfile(input: UpdateProfileInput, reqHeaders: NodeHeaders, resHeaders: Headers) {
    if (input.language !== undefined) {
      assertSupportedLanguage(input.language, this.platformConfig);
    }
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
    forwardCookies(res, resHeaders);
    // updateUser returns { status } only - re-read from session to get the full user.
    const session = await this.auth.api.getSession({ headers });
    const current = session?.user as BetterAuthUser | undefined;
    if (current) {
      this.events.emit('identity.profile.updated', { userId: current.id });
    }
    if (!current) {
      throw new Error('Profile update succeeded but session could not be re-read');
    }
    return { user: toUser(current) };
  }
}

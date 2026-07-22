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
  EmailTemplateRenderer,
  LoginInput,
  RegisterInput,
  Enable2faInput,
  Verify2faInput,
  Disable2faInput,
  RequestPasswordResetInput,
  VerifyPasswordResetOtpInput,
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
import { RATE_LIMIT_KEYS, makeRateLimitKey } from '@openora/core/contracts';
import { assertSupportedLanguage } from '../../shared/language.js';
import { isRgBlocked } from './rg-guard.service.js';

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

function clientIp(headers: Headers): string | null {
  return headers.get('x-forwarded-for')?.split(',')[0]?.trim() || headers.get('x-real-ip') || null;
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
  requestPasswordResetEmailOTP: AuthCall<{ email: string }>;
  checkVerificationOTP: AuthCall<{ email: string; type: 'forget-password'; otp: string }>;
  resetPasswordEmailOTP: AuthCall<{ email: string; otp: string; password: string }>;
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
  try {
    const parsed = JSON.parse(await res.text()) as { message?: string };
    if (parsed.message) {
      message = parsed.message;
    }
  } catch {
    // non-JSON body - keep the default message
  }
  throw new ORPCError(code, { message });
}

const DEFAULT_MAX_LOGIN_ATTEMPTS = 5;
const DEFAULT_LOCKOUT_DURATION_MS = 15 * 60 * 1000;

// Progressive lockout: a repeat lockout inside a rolling 24h window escalates the
// duration (1 min -> 5 min -> 15 min, capped at tier 3). The window resets once the
// last lockout falls outside it, so an occasional fat-finger never compounds.
const LOCKOUT_WINDOW_MS = 24 * 60 * 60 * 1000;
const LOCKOUT_TIER_DURATIONS_MS = [60_000, 5 * 60_000, 15 * 60_000] as const;

function computeLockoutTier({
  lockoutCount,
  lastLockoutAt,
  nowMs,
  fallbackDurationMs,
}: {
  lockoutCount: number;
  lastLockoutAt: Date | null;
  nowMs: number;
  fallbackDurationMs: number;
}) {
  const withinWindow =
    lastLockoutAt !== null && nowMs - lastLockoutAt.getTime() < LOCKOUT_WINDOW_MS;
  const tier = withinWindow ? lockoutCount + 1 : 1;
  const durationMs = LOCKOUT_TIER_DURATIONS_MS[Math.min(tier - 1, 2)] ?? fallbackDurationMs;
  return { tier, durationMs };
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
const EMAIL_VERIFICATION_RATE_LIMIT = { limit: 3, windowMs: 15 * MINUTE_MS };
const VERIFY_EMAIL_RATE_LIMIT = { limit: 5, windowMs: 15 * MINUTE_MS };
const CHANGE_PASSWORD_RATE_LIMIT = { limit: 5, windowMs: 15 * MINUTE_MS };
const TWO_FACTOR_PASSWORD_RATE_LIMIT = { limit: 5, windowMs: 5 * MINUTE_MS };

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
  email?: SendEmailPort;
  templateRenderer: EmailTemplateRenderer;
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
  private readonly templateRenderer: EmailTemplateRenderer;
  private readonly options?: IdentityServiceOptions;
  private readonly limiter?: RateLimiterAdapter<RateLimitKey>;
  private readonly platformConfig?: PlatformConfig;

  constructor({
    drizzle,
    events,
    email,
    templateRenderer,
    options,
    limiter,
    platformConfig,
  }: IdentityServiceDeps) {
    this.drizzle = drizzle;
    this.events = events;
    this.email = email;
    this.templateRenderer = templateRenderer;
    this.options = options;
    this.limiter = limiter;
    this.platformConfig = platformConfig;
    this.auth = createAuth({
      db: drizzle.db,
      schema: { user, session, account, verification, twoFactor },
      ...(email ? { sendEmail: (args) => email.send(args) } : {}),
      templateRenderer: this.templateRenderer,
      getUserLanguage: (lookupEmail) => this.resolveUserLanguage(lookupEmail),
      onPasswordReset: async (resetUser) => {
        this.events.emit('identity.password.reset', { userId: resetUser.id });
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
    this.forwardCookies(authResponse, resHeaders);
    const body = (await authResponse.json()) as { user: BetterAuthUser };

    const ip = clientIp(headers);
    const userAgent = headers.get('user-agent') || null;
    this.events.emit('identity.user.registered', { userId: body.user.id, ip, userAgent });
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
          | 'role'
          | 'rgBlocked'
          | 'rgBlockedUntil'
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
          data: { code: 'RG_BLOCKED' },
        });
      }

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

      this.events.emit('identity.user.login', { userId: body.user.id, ip, userAgent });
      const sessionDurationSeconds =
        this.auth.options.session?.expiresIn ?? SESSION_DURATION_IN_SECONDS;
      const expiresAt = body.session?.expiresAt
        ? toIso(body.session.expiresAt)
        : new Date(Date.now() + sessionDurationSeconds * 1000).toISOString();
      return {
        user: toUser(body.user),
        session: { token: body.token, expiresAt },
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
        (error.data as { code?: string } | undefined)?.code === 'RG_BLOCKED'
      ) {
        throw error;
      }
      // Only a genuine credential rejection counts toward lockout - a transient DB/network
      // error must never lock the account out.
      const isCredentialFailure = error instanceof ORPCError && error.code === 'UNAUTHORIZED';

      let attemptsRemaining: number | undefined;
      if (lockoutEnabled && existingUser && isCredentialFailure) {
        const maxAttempts = this.options?.lockout?.maxAttempts ?? DEFAULT_MAX_LOGIN_ATTEMPTS;
        const fallbackDurationMs = this.options?.lockout?.durationMs ?? DEFAULT_LOCKOUT_DURATION_MS;
        // Atomic increment: concurrent failures can't each read a stale count and slip past
        // the threshold (the read-modify-write this replaces was bypassable under load).
        const [row] = await this.drizzle.db
          .update(user)
          .set({ failedLoginAttempts: sql`${user.failedLoginAttempts} + 1` })
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
            lastLockoutAt: existingUser.lastLockoutAt ?? null,
            nowMs,
            fallbackDurationMs,
          });
          const lockoutUntil = new Date(nowMs + durationMs);
          await this.drizzle.db
            .update(user)
            .set({ lockoutUntil, lockoutCount: tier, lastLockoutAt: new Date(nowMs) })
            .where(eq(user.id, existingUser.id));

          await this.limiter?.reset(makeLoginRateLimitKey(email));

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
      this.events.emit('identity.user.login.failed', {
        email,
        reason,
        ip,
        userAgent,
        ...(attemptsRemaining !== undefined ? { attemptsRemaining } : {}),
      });
      throw error;
    }
  }

  private clearLockout(userId: User['id']) {
    return this.drizzle.db
      .update(user)
      .set({ failedLoginAttempts: 0, lockoutUntil: null })
      .where(eq(user.id, userId));
  }

  async unlockUser(
    userId: User['id'],
    actorId: User['id'],
    meta?: { ip?: string | null; userAgent?: string | null },
  ) {
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
    const headers = nodeHeadersToHeaders(reqHeaders);
    // Resolve the user BEFORE signOut so the audit log can attribute the logout.
    const session = await this.auth.api.getSession({ headers });
    const userId = (session?.user as BetterAuthUser | undefined)?.id;
    const authResponse = await this.auth.api.signOut({ headers, asResponse: true });
    this.forwardCookies(authResponse, resHeaders);
    if (userId) {
      const ip = clientIp(headers);
      const userAgent = headers.get('user-agent') || null;
      this.events.emit('identity.user.logout', { userId, ip, userAgent });
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
    this.forwardCookies(res, resHeaders);
    const userId = await this.currentUserId(headers);
    if (userId) {
      const ip = clientIp(headers);
      const userAgent = headers.get('user-agent') || null;
      this.events.emit('identity.2fa.enabled', { userId, ip, userAgent });
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
    this.forwardCookies(res, resHeaders);
    if (userId) {
      const ip = clientIp(headers);
      const userAgent = headers.get('user-agent') || null;
      this.events.emit('identity.2fa.disabled', { userId, ip, userAgent });
    }
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

  async resetPassword(input: ResetPasswordInput, reqHeaders?: NodeHeaders) {
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

    const row = await this.findUserByEmail(email);
    if (row) {
      const headers = reqHeaders ? nodeHeadersToHeaders(reqHeaders) : null;
      const ip = headers ? clientIp(headers) : null;
      const userAgent = headers ? headers.get('user-agent') || null : null;
      this.events.emit('identity.password.reset', { userId: row.id, ip, userAgent });
      await this.clearLockout(row.id);
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
    this.forwardCookies(res, resHeaders);
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
      const ip = clientIp(headers);
      const userAgent = headers.get('user-agent') || null;
      this.events.emit('identity.email.verified', { userId, ip, userAgent });
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
    this.forwardCookies(res, resHeaders);
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
    this.forwardCookies(res, resHeaders);
    // updateUser returns { status } only - re-read from session to get the full user.
    const session = await this.auth.api.getSession({ headers });
    const current = session?.user as BetterAuthUser | undefined;
    if (current) {
      const ip = clientIp(headers);
      const userAgent = headers.get('user-agent') || null;
      this.events.emit('identity.profile.updated', { userId: current.id, ip, userAgent });
    }
    if (!current) {
      throw new Error('Profile update succeeded but session could not be re-read');
    }
    return { user: toUser(current) };
  }
}

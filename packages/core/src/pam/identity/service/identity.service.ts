import { ORPCError } from '@orpc/server';
import {
  createAuth,
  type EventBus,
  type NodeHeaders,
  DrizzleService,
} from '@blurifycom/core/server';
import { eq, sql } from 'drizzle-orm';
import { user, session, account, verification, twoFactor } from '../schema/index.js';
import type {
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
  ChangePasswordInput,
  ChangeEmailInput,
  IdentityServiceOptions,
} from '@blurifycom/core/contracts';

function nodeHeadersToHeaders(nodeHeaders: NodeHeaders) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(nodeHeaders)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  return headers;
}

// better-auth returns Date objects; the public UserSchema requires ISO strings.
type BetterAuthUser = {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  image?: string | null;
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
  updateUser: AuthCall<{ name?: string; image?: string | null }>;
};

const SUCCESS = { success: true as const };

// better-auth calls use `asResponse: true`, which returns an error *Response*
// (4xx/5xx) rather than throwing. Surface those as ORPCErrors so oRPC maps them
// to the right HTTP status instead of the handler silently returning success.
// Only reads the body on failure, so a subsequent res.json() on success is safe.
async function ensureOk(res: globalThis.Response) {
  if (res.ok) return;
  let message = `Request failed (${res.status})`;
  try {
    const parsed = JSON.parse(await res.text()) as { message?: string };
    if (parsed.message) message = parsed.message;
  } catch {
    // non-JSON body - keep the default message
  }
  throw new ORPCError(res.status === 401 ? 'UNAUTHORIZED' : 'BAD_REQUEST', { message });
}

const DEFAULT_MAX_LOGIN_ATTEMPTS = 5;
const DEFAULT_LOCKOUT_DURATION_MS = 15 * 60 * 1000;
// Mirrors better-auth session.expiresIn (server/auth/auth.ts); used only as a fallback
// when the sign-in response omits an explicit session expiry.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Pure lockout decision: does this attempt count trip the lock, and until when. */
function computeLockoutState(
  attempts: number,
  maxAttempts: number,
  durationMs: number,
  nowMs: number,
) {
  const isLocking = attempts >= maxAttempts;
  return { isLocking, lockoutUntil: isLocking ? new Date(nowMs + durationMs) : null };
}

export type IdentityServiceDeps = {
  drizzle: DrizzleService;
  events: EventBus;
  email?: SendEmailPort;
  options?: IdentityServiceOptions;
};

export class IdentityService {
  private readonly auth: ReturnType<typeof createAuth>;
  private readonly drizzle: DrizzleService;
  private readonly events: EventBus;
  private readonly email?: SendEmailPort;
  private readonly options?: IdentityServiceOptions;

  constructor({ drizzle, events, email, options }: IdentityServiceDeps) {
    this.drizzle = drizzle;
    this.events = events;
    this.email = email;
    this.options = options;
    this.auth = createAuth({
      db: drizzle.db,
      schema: { user, session, account, verification, twoFactor },
      ...(email ? { sendEmail: (args) => email.send(args) } : {}),
    });
  }

  private get api() {
    return this.auth.api as unknown as ExtendedAuthApi;
  }

  private async currentUserId(headers: Headers) {
    const session = await this.auth.api.getSession({ headers });
    return session?.user?.id ?? null;
  }

  async register(input: RegisterInput, reqHeaders: NodeHeaders, resHeaders: Headers) {
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

  async login(input: LoginInput, reqHeaders: NodeHeaders, resHeaders: Headers) {
    const headers = nodeHeadersToHeaders(reqHeaders);
    const ip =
      headers.get('x-forwarded-for')?.split(',')[0]?.trim() || headers.get('x-real-ip') || null;
    const userAgent = headers.get('user-agent') || null;
    // better-auth lowercases emails on write, so the lockout lookup must match on the same form.
    const email = input.email.toLowerCase();

    const lockoutEnabled = this.options?.lockout?.enabled ?? true;
    let existingUser:
      | Pick<typeof user.$inferSelect, 'id' | 'failedLoginAttempts' | 'lockoutUntil'>
      | undefined;

    if (lockoutEnabled) {
      const [dbUser] = await this.drizzle.db
        .select({
          id: user.id,
          failedLoginAttempts: user.failedLoginAttempts,
          lockoutUntil: user.lockoutUntil,
        })
        .from(user)
        .where(eq(user.email, email))
        .limit(1);
      existingUser = dbUser;

      if (existingUser?.lockoutUntil) {
        if (new Date(existingUser.lockoutUntil) > new Date()) {
          throw new ORPCError('UNAUTHORIZED', {
            message: 'Account is temporarily locked. Please try again later.',
            data: { lockoutUntil: existingUser.lockoutUntil.toISOString() },
          });
        }
        // Lock window elapsed: clear it so the next failure starts from a fresh budget
        // instead of one more wrong password immediately re-locking the account.
        await this.clearLockout(existingUser.id);
        existingUser = { ...existingUser, failedLoginAttempts: 0, lockoutUntil: null };
      }
    }

    try {
      const authResponse = await this.auth.api.signInEmail({
        body: { email, password: input.password, rememberMe: input.rememberMe },
        headers,
        asResponse: true,
      });
      await ensureOk(authResponse);
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
        const { isLocking, lockoutUntil } = computeLockoutState(
          newAttempts,
          maxAttempts,
          durationMs,
          Date.now(),
        );

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

          throw new ORPCError('UNAUTHORIZED', {
            message: 'Account is temporarily locked. Please try again later.',
            data: { lockoutUntil: lockoutUntil.toISOString() },
          });
        }
      }

      const reason = isCredentialFailure ? 'invalid_credentials' : 'error';
      this.events.emit('identity.user.login.failed', { email, reason, ip, userAgent });
      throw error;
    }
  }

  private clearLockout(userId: string) {
    return this.drizzle.db
      .update(user)
      .set({ failedLoginAttempts: 0, lockoutUntil: null })
      .where(eq(user.id, userId));
  }

  async unlockUser(userId: string, actorId: string) {
    const [existingUser] = await this.drizzle.db
      .select({
        id: user.id,
        email: user.email,
        failedLoginAttempts: user.failedLoginAttempts,
        lockoutUntil: user.lockoutUntil,
      })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);

    if (!existingUser) {
      throw new ORPCError('NOT_FOUND', { message: 'User not found' });
    }

    await this.clearLockout(userId);

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
    if (userId) this.events.emit('identity.user.logout', { userId });
    return SUCCESS;
  }

  async me(reqHeaders: NodeHeaders) {
    const headers = nodeHeadersToHeaders(reqHeaders);
    const session = await this.auth.api.getSession({ headers });
    if (!session?.user) return null;
    return toUser(session.user as BetterAuthUser);
  }

  async enableTwoFactor(input: Enable2faInput, reqHeaders: NodeHeaders, resHeaders: Headers) {
    const headers = nodeHeadersToHeaders(reqHeaders);
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
    const res = await this.api.verifyTOTP({
      body: { code: input.code },
      headers,
      asResponse: true,
    });
    await ensureOk(res);
    forwardCookies(res, resHeaders);
    const userId = await this.currentUserId(headers);
    if (userId) this.events.emit('identity.2fa.enabled', { userId });
    return SUCCESS;
  }

  async disableTwoFactor(input: Disable2faInput, reqHeaders: NodeHeaders, resHeaders: Headers) {
    const headers = nodeHeadersToHeaders(reqHeaders);
    const userId = await this.currentUserId(headers);
    const res = await this.api.disableTwoFactor({
      body: { password: input.password },
      headers,
      asResponse: true,
    });
    await ensureOk(res);
    forwardCookies(res, resHeaders);
    if (userId) this.events.emit('identity.2fa.disabled', { userId });
    return SUCCESS;
  }

  async requestPasswordReset(input: RequestPasswordResetInput) {
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
      await this.api.sendVerificationEmail({ body: { email }, headers, asResponse: true });
    }
    return SUCCESS;
  }

  async verifyEmail(input: VerifyEmailInput, reqHeaders: NodeHeaders) {
    const headers = nodeHeadersToHeaders(reqHeaders);
    const res = await this.api.verifyEmail({
      query: { token: input.token },
      headers,
      asResponse: true,
    });
    await ensureOk(res);
    const userId = await this.currentUserId(headers);
    if (userId) this.events.emit('identity.email.verified', { userId });
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
    const headers = nodeHeadersToHeaders(reqHeaders);
    const body: { name?: string; image?: string | null } = {};
    if (input.name !== undefined) body.name = input.name;
    if (input.image !== undefined) body.image = input.image;
    const res = await this.api.updateUser({ body, headers, asResponse: true });
    await ensureOk(res);
    forwardCookies(res, resHeaders);
    // updateUser returns { status } only - re-read from session to get the full user.
    const session = await this.auth.api.getSession({ headers });
    const current = session?.user as BetterAuthUser | undefined;
    if (current) this.events.emit('identity.profile.updated', { userId: current.id });
    if (!current) {
      throw new Error('Profile update succeeded but session could not be re-read');
    }
    return { user: toUser(current) };
  }
}

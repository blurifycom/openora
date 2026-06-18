import { ORPCError } from '@orpc/server';
import { createAuth } from '@oss/core/server';
import { type EventBus } from '@oss/core/server';
import type { SendEmailPort } from '@oss/core/contracts';
import { DrizzleService } from '@oss/core/server';
import { user, session, account, verification, twoFactor } from '../schema/index.js';
import type { User } from '@oss/core/contracts';
import type {
  LoginInput,
  RegisterInput,
  Enable2faInput,
  Enable2faResult,
  Verify2faInput,
  Disable2faInput,
  RequestPasswordResetInput,
  ResetPasswordInput,
  VerifyEmailInput,
  UpdateProfileInput,
  ChangePasswordInput,
  ChangeEmailInput,
} from '@oss/core/contracts';

function nodeHeadersToHeaders(nodeHeaders: Record<string, string | string[] | undefined>): Headers {
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

function toUser(u: BetterAuthUser): User {
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
async function ensureOk(res: globalThis.Response): Promise<void> {
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

export class IdentityService {
  private readonly auth: ReturnType<typeof createAuth>;

  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
    private readonly email?: SendEmailPort,
  ) {
    this.auth = createAuth({
      db: this.drizzle.db,
      schema: { user, session, account, verification, twoFactor },
      ...(email ? { sendEmail: (args) => email.send(args) } : {}),
    });
  }

  private get api(): ExtendedAuthApi {
    return this.auth.api as unknown as ExtendedAuthApi;
  }

  private async currentUserId(headers: Headers): Promise<string | null> {
    const session = await this.auth.api.getSession({ headers });
    return session?.user?.id ?? null;
  }

  async register(
    input: RegisterInput,
    reqHeaders: Record<string, string | string[] | undefined>,
    resHeaders: Headers,
  ) {
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

  async login(
    input: LoginInput,
    reqHeaders: Record<string, string | string[] | undefined>,
    resHeaders: Headers,
  ) {
    const headers = nodeHeadersToHeaders(reqHeaders);
    const authResponse = await this.auth.api.signInEmail({
      body: { email: input.email, password: input.password },
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

    this.events.emit('identity.user.login', { userId: body.user.id });
    const expiresAt = body.session?.expiresAt
      ? toIso(body.session.expiresAt)
      : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    return {
      user: toUser(body.user),
      session: { token: body.token, expiresAt },
    };
  }

  async logout(reqHeaders: Record<string, string | string[] | undefined>, resHeaders: Headers) {
    const headers = nodeHeadersToHeaders(reqHeaders);
    // Resolve the user BEFORE signOut so the audit log can attribute the logout.
    const session = await this.auth.api.getSession({ headers });
    const userId = (session?.user as BetterAuthUser | undefined)?.id;
    const authResponse = await this.auth.api.signOut({ headers, asResponse: true });
    forwardCookies(authResponse, resHeaders);
    if (userId) this.events.emit('identity.user.logout', { userId });
    return SUCCESS;
  }

  async me(reqHeaders: Record<string, string | string[] | undefined>): Promise<User | null> {
    const headers = nodeHeadersToHeaders(reqHeaders);
    const session = await this.auth.api.getSession({ headers });
    if (!session?.user) return null;
    return toUser(session.user as BetterAuthUser);
  }

  async enableTwoFactor(
    input: Enable2faInput,
    reqHeaders: Record<string, string | string[] | undefined>,
    resHeaders: Headers,
  ): Promise<Enable2faResult> {
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

  async verifyTwoFactor(
    input: Verify2faInput,
    reqHeaders: Record<string, string | string[] | undefined>,
    resHeaders: Headers,
  ) {
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

  async disableTwoFactor(
    input: Disable2faInput,
    reqHeaders: Record<string, string | string[] | undefined>,
    resHeaders: Headers,
  ) {
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
    if (body.user?.id) this.events.emit('identity.password.reset', { userId: body.user.id });
    return SUCCESS;
  }

  async changePassword(
    input: ChangePasswordInput,
    reqHeaders: Record<string, string | string[] | undefined>,
    resHeaders: Headers,
  ) {
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

  async sendEmailVerification(reqHeaders: Record<string, string | string[] | undefined>) {
    const headers = nodeHeadersToHeaders(reqHeaders);
    const session = await this.auth.api.getSession({ headers });
    const email = session?.user?.email;
    if (email) {
      await this.api.sendVerificationEmail({ body: { email }, headers, asResponse: true });
    }
    return SUCCESS;
  }

  async verifyEmail(
    input: VerifyEmailInput,
    reqHeaders: Record<string, string | string[] | undefined>,
  ) {
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

  async changeEmail(
    input: ChangeEmailInput,
    reqHeaders: Record<string, string | string[] | undefined>,
    resHeaders: Headers,
  ) {
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

  async updateProfile(
    input: UpdateProfileInput,
    reqHeaders: Record<string, string | string[] | undefined>,
    resHeaders: Headers,
  ): Promise<{ user: User }> {
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

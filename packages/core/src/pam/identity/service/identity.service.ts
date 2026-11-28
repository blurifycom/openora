import { randomUUID } from 'node:crypto';
import { ORPCError } from '@orpc/server';
import {
  createAuth,
  runInAuthTransaction,
  type EventBus,
  type NodeHeaders,
  DrizzleService,
  assertRateLimit,
  extractClientMeta,
  getCurrentClientMeta,
  findOneOrThrow,
  makeConflictError,
  makeNotFoundError,
  createDomainError,
  createLogger,
  type DrizzleTx,
} from '@openora/core/server';
import { parseCookies } from 'better-auth/cookies';
import { and, eq, isNull, like, lte, ne, sql } from 'drizzle-orm';
import * as z from 'zod';
import { user, session, account, verification, twoFactor, type Session } from '../schema/index.js';
import { captureTimezone } from './capture-timezone.service.js';
import type { PlayEligibilityPublisher } from './play-eligibility.service.js';
import type { SessionService } from './session.service.js';
import type { TrustedDeviceService } from './trusted-device.service.js';
import type { TwoFactorLockoutService } from './two-factor-lockout.service.js';
import {
  maskEmail,
  maskPhone,
  type TwoFactorDeliveryService,
} from './two-factor-delivery.service.js';
import type {
  AuditWritePort,
  CacheAdapter,
  RateLimiterAdapter,
  RateLimitKey,
  MailDispatchPort,
  LoginInput,
  RegisterInput,
  RegistrationAcquisition,
  Enable2faInput,
  Enable2faResult,
  Verify2faInput,
  TwoFactorChallengeMethod,
  TwoFactorDeliveryMethod,
  StepUpMethod,
  TwoFactorStatus,
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
  RequestEmailChangeInput,
  ConfirmEmailChangeInput,
  IdentityServiceOptions,
  PlatformConfig,
  ClientMeta,
  RegistrationFailureReason,
  RegistrationPolicy,
  GeoCheckCommands,
  PlayerProvisioning,
  SecurityControls,
  SetAntiPhishingCodeInput,
  SetAutoLogoutInput,
  SetLoginWithdrawalAlertsInput,
  SetRequireTwoFactorOnLoginInput,
  Uuid,
} from '@openora/core/contracts';
import {
  RATE_LIMIT_KEYS,
  isAllowedHttpsUrl,
  isAllowedUrlPrefix,
  makeRateLimitKey,
  resolveMinPlayerAge,
} from '@openora/core/contracts';
import { assertSupportedLanguage } from '../../shared/language.js';
import { assertAccountNotBlocked, assertCountryAllowed } from './rg-guard.service.js';
import { assertUsernameAllowed, isUsernameAllowed } from '../../shared/username.js';
import {
  DEFAULT_LOCKOUT_DURATION_MS,
  DEFAULT_MAX_LOGIN_ATTEMPTS,
  computeLockoutTier,
  createAccountLockedError,
  hasFailedLoginWindowExpired,
  makeLoginSecurityState,
} from './lockout-policy.service.js';
import { getSecurityControls } from './security-controls.service.js';
import { countRemainingBackupCodes } from './backup-codes.service.js';
import {
  isLostBackupCodeRace,
  resolveChallengeMethod,
  verifyChallengeCode,
} from './two-factor-challenge.service.js';
import {
  assertAccountPassword,
  assertFreshReauthentication,
} from './fresh-reauthentication.service.js';

const TwoFactorVerificationResponseSchema = z.object({
  token: z.string(),
  user: z.object({ id: z.string() }).optional(),
});

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

async function sweepRacedSessionsAfterPasswordChange(
  db: DrizzleService['db'],
  params: { userId: User['id']; sparedToken: Session['token']; deadline: Date },
): Promise<Session['id'][]> {
  const { userId, sparedToken, deadline } = params;
  const deleted = await db
    .delete(session)
    .where(
      and(
        eq(session.userId, userId),
        ne(session.token, sparedToken),
        lte(session.createdAt, deadline),
      ),
    )
    .returning({ id: session.id });
  return deleted.map((row) => row.id);
}

type BetterAuthUser = Omit<User, 'theme' | 'language' | 'createdAt' | 'updatedAt'> & {
  theme?: Theme | null;
  language?: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

export function toUser(u: BetterAuthUser) {
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

export function makeLoginRateLimitKey(email: string): `login:${string}` {
  return `login:${email.toLowerCase()}`;
}

function makeLoginIpRateLimitKey(ip: string): `login-ip:${string}` {
  return `login-ip:${ip}`;
}

function twoFactorPendingCookieValue(headers: Headers, cookieName: string): string | undefined {
  const cookieHeader = headers.get('cookie');
  if (!cookieHeader) {
    return undefined;
  }
  for (const [name, value] of parseCookies(cookieHeader)) {
    if (name === cookieName) {
      return value;
    }
  }
  return undefined;
}

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

function hasDontRememberCookie(headers: Headers): boolean {
  const cookieHeader = headers.get('cookie');
  if (!cookieHeader) {
    return false;
  }
  for (const [name] of parseCookies(cookieHeader)) {
    if (name.endsWith('.dont_remember') || name === 'dont_remember') {
      return true;
    }
  }
  return false;
}

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

type AuthCall<B> = (opts: {
  body?: B;
  query?: Record<string, string>;
  headers: Headers;
  asResponse: true;
}) => Promise<globalThis.Response>;

const pendingEmailChangeIdentifierPattern = (userId: Uuid) => `change-email-otp-${userId}:%`;

type ExtendedAuthApi = {
  signUpEmail: AuthCall<
    Pick<typeof user.$inferInsert, 'email' | 'name' | 'username'> & { password: string }
  >;
  enableTwoFactor: AuthCall<{ password: string }>;
  verifyTOTP: AuthCall<{ code: string; trustDevice?: boolean }>;
  verifyBackupCode: AuthCall<{ code: string; trustDevice?: boolean }>;
  sendTwoFactorOTP: AuthCall<Record<string, never>>;
  verifyTwoFactorOTP: AuthCall<{ code: string; trustDevice?: boolean }>;
  generateBackupCodes: AuthCall<{ password: string }>;
  disableTwoFactor: AuthCall<{ password: string }>;
  requestPasswordResetEmailOTP: AuthCall<{ email: string }>;
  checkVerificationOTP: AuthCall<{ email: string; type: 'forget-password'; otp: string }>;
  resetPasswordEmailOTP: AuthCall<{ email: string; otp: string; password: string }>;
  sendVerificationOTP: AuthCall<{ email: string; type: 'email-verification' }>;
  verifyEmailOTP: AuthCall<{ email: string; otp: string }>;
  changePassword: AuthCall<{
    currentPassword: string;
    newPassword: string;
    revokeOtherSessions?: boolean;
  }>;
  requestEmailChangeEmailOTP: AuthCall<{ newEmail: string }>;
  changeEmailEmailOTP: AuthCall<{ newEmail: string; otp: string }>;
  updateUser: AuthCall<{ name?: string; image?: string | null; theme?: Theme; language?: string }>;
};

const SUCCESS = { success: true as const };

const AUTH_SCHEMA = { user, session, account, verification, twoFactor };

export const UserNotFoundError = makeNotFoundError('User');
export const UsernameConflictError = makeConflictError('Username', 'Username is already in use');
const EmailChangeWithoutHistoryError = createDomainError<[]>(
  'EmailChangeWithoutHistoryError',
  () => 'The email change was refused after the address was swapped',
);
export const AvatarHostNotAllowedError = createDomainError<[]>(
  'AvatarHostNotAllowedError',
  () => 'Avatar URL is not on an allowed host or URL prefix',
  { reason: 'avatar_host_not_allowed' },
);

function isAllowedAvatarUrl(
  image: string,
  config: PlatformConfig['identity'] | undefined,
): boolean {
  return (
    isAllowedHttpsUrl(image, config?.allowedAvatarHosts ?? []) ||
    isAllowedUrlPrefix(image, config?.allowedAvatarUrlPrefixes ?? [])
  );
}

const BetterAuthErrorBodySchema = z.object({
  message: z.string().optional(),
  code: z.string().optional(),
});

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

async function isUserInsertFailure(res: globalThis.Response) {
  const body = BetterAuthErrorBodySchema.safeParse(
    await res
      .clone()
      .json()
      .catch(() => null),
  );
  return body.success && body.data.code === 'FAILED_TO_CREATE_USER';
}

const MINUTE_MS = 60 * 1000;
const SESSION_DURATION_IN_SECONDS = 30 * 24 * 60 * 60;
const LOGIN_RATE_LIMIT = { limit: 10, windowMs: 5 * MINUTE_MS, onUnavailable: 'deny' } as const;
const DEFAULT_LOGIN_IP_RATE_LIMIT = {
  limit: 100,
  windowMs: 15 * MINUTE_MS,
  onUnavailable: 'deny',
} as const;
const REGISTER_RATE_LIMIT = { limit: 5, windowMs: 15 * MINUTE_MS };
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
const EMAIL_VERIFICATION_RATE_LIMIT = {
  limit: 3,
  windowMs: 15 * MINUTE_MS,
  onUnavailable: 'deny',
} as const;
const VERIFY_EMAIL_RATE_LIMIT = {
  limit: 5,
  windowMs: 15 * MINUTE_MS,
  onUnavailable: 'deny',
} as const;
const CHANGE_PASSWORD_RATE_LIMIT = { limit: 5, windowMs: 15 * MINUTE_MS };
const RACED_SESSION_SWEEP_DELAY_MS = 2_000;
const DONT_REMEMBER_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const TWO_FACTOR_PASSWORD_RATE_LIMIT = { limit: 5, windowMs: 5 * MINUTE_MS };
const SEND_2FA_OTP_RATE_LIMIT = {
  limit: 3,
  windowMs: 5 * MINUTE_MS,
  onUnavailable: 'deny',
} as const;
const ANTI_PHISHING_CODE_RATE_LIMIT = {
  limit: 5,
  windowMs: 5 * MINUTE_MS,
  onUnavailable: 'deny',
} as const;
const FAKE_LOGIN_SHADOW_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type FakeLoginShadow = {
  failedAttempts: number;
  lockoutUntil: string | null;
  lockoutCount: number;
  lastLockoutAt: string | null;
  lastFailedLoginAt: string | null;
};

export function loginShadowKey(email: string): string {
  return `login-shadow:${email}`;
}

const loginShadowLogger = createLogger('login-shadow');
const identityLogger = createLogger('identity');

function matchesAudience(role: string, audience: 'staff' | 'player'): boolean {
  return (role === 'player') === (audience === 'player');
}

const NO_ROLE = { role: 'player' };

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
  audit: AuditWritePort;
  identityReader: IdentityReader;
  mailDispatch?: MailDispatchPort;
  options?: IdentityServiceOptions;
  limiter?: RateLimiterAdapter<RateLimitKey>;
  platformConfig?: PlatformConfig;
  geoCheck?: GeoCheckCommands;
  playerProvisioning?: PlayerProvisioning;
  cache?: CacheAdapter;
  trustedDevices?: TrustedDeviceService;
  twoFactorLockout?: TwoFactorLockoutService;
  twoFactorDelivery: TwoFactorDeliveryService;
  sessions?: SessionService;
  playEligibility: PlayEligibilityPublisher;
};

export class IdentityService {
  private readonly auth: ReturnType<typeof createAuth>;
  private readonly drizzle: DrizzleService;
  private readonly events: EventBus;
  private readonly audit: AuditWritePort;
  private readonly identityReader: IdentityReader;
  private readonly mailDispatch?: MailDispatchPort;
  private readonly options?: IdentityServiceOptions;
  private readonly limiter?: RateLimiterAdapter<RateLimitKey>;
  private readonly platformConfig?: PlatformConfig;
  private readonly playerProvisioning?: PlayerProvisioning;
  private readonly geoCheck?: GeoCheckCommands;
  private readonly cache?: CacheAdapter;
  private readonly existingAccountSignUps = new Set<string>();
  private readonly trustedDevices?: TrustedDeviceService;
  private readonly twoFactorLockout?: TwoFactorLockoutService;
  private readonly twoFactorDelivery: TwoFactorDeliveryService;
  private readonly sessions?: SessionService;
  private readonly playEligibility: PlayEligibilityPublisher;

  constructor({
    drizzle,
    events,
    audit,
    identityReader,
    mailDispatch,
    options,
    limiter,
    platformConfig,
    geoCheck,
    playerProvisioning,
    cache,
    trustedDevices,
    twoFactorLockout,
    twoFactorDelivery,
    sessions,
    playEligibility,
  }: IdentityServiceDeps) {
    this.drizzle = drizzle;
    this.events = events;
    this.audit = audit;
    this.identityReader = identityReader;
    this.mailDispatch = mailDispatch;
    this.options = options;
    this.limiter = limiter;
    this.platformConfig = platformConfig;
    this.geoCheck = geoCheck;
    this.playerProvisioning = playerProvisioning;
    this.cache = cache;
    this.trustedDevices = trustedDevices;
    this.twoFactorLockout = twoFactorLockout;
    this.twoFactorDelivery = twoFactorDelivery;
    this.sessions = sessions;
    this.playEligibility = playEligibility;
    this.auth = createAuth({
      db: drizzle.db,
      schema: AUTH_SCHEMA,
      ...(mailDispatch
        ? {
            dispatchOtpMail: async ({ to, template, recipientName, antiPhishingCode }) => {
              const idempotencyKey = `otp:${template.key}:${randomUUID()}`;
              const recipient = await this.findUserByEmail(to);
              if (recipient) {
                await mailDispatch.toUser({ userId: recipient.id, template, idempotencyKey });
                return;
              }
              await mailDispatch.toAddress({
                email: to,
                template,
                idempotencyKey,
                ...(recipientName !== undefined ? { recipientName } : {}),
                ...(antiPhishingCode !== undefined ? { antiPhishingCode } : {}),
              });
            },
          }
        : {}),
      twoFactor: { sendOtp: (args) => twoFactorDelivery.deliver(args) },
      requireEmailVerification:
        this.platformConfig?.registration?.requireEmailVerification ?? false,
      isExistingAccountSignUp: (lookupEmail) =>
        this.existingAccountSignUps.has(lookupEmail.toLowerCase()),
      isAdminPasswordReset: (lookupEmail) => this.isAdminPasswordReset(lookupEmail),
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
        await this.drizzle.db
          .update(user)
          .set({ passwordMeetsPolicy: true })
          .where(eq(user.id, resetUser.id));
        const meta = getCurrentClientMeta();
        this.events.emit('identity.password.reset', {
          userId: resetUser.id,
          playerId: await this.identityReader.getPlayerIdByUserIdSafe(resetUser.id),
          ...meta,
        });
        await this.clearLockout(resetUser.id);
        await this.endSessionsAfterPasswordReset(resetUser.id, meta);
      },
    });
  }

  private async endSessionsAfterPasswordReset(userId: User['id'], meta: ClientMeta) {
    try {
      await this.sessions?.endSessionsAfterPasswordReset(userId, meta);
    } catch (err) {
      identityLogger.error({ err, userId }, 'MCP token revocation after a password reset failed');
    }
  }

  private async revokeMcpTokensAfterCredentialChange(userId: User['id'], meta: ClientMeta) {
    try {
      await this.sessions?.revokeMcpTokens(userId, userId, meta);
    } catch (err) {
      identityLogger.error({ err, userId }, 'MCP token revocation after a password change failed');
    }
  }

  private async findUserByEmail(email: string): Promise<{ id: User['id'] } | undefined> {
    const [row] = await this.drizzle.db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, email.toLowerCase()))
      .limit(1);
    return row;
  }

  private get api() {
    return this.auth.api as unknown as ExtendedAuthApi;
  }

  private forwardCookies(authResponse: globalThis.Response, resHeaders: Headers): void {
    const cookies = authResponse.headers.getSetCookie?.() ?? [];
    for (const cookie of cookies) {
      resHeaders.append('set-cookie', cookie);
    }
  }

  private async currentUserId(headers: Headers) {
    return (await this.currentSession(headers))?.userId ?? null;
  }

  private async currentSession(
    headers: Headers,
  ): Promise<{ userId: User['id']; sessionId?: Session['id'] } | null> {
    const resolved = await this.auth.api.getSession({ headers });
    const userId = resolved?.user?.id;
    return userId ? { userId, sessionId: resolved?.session?.id } : null;
  }

  private async securityControlsFor(userId: User['id']): Promise<SecurityControls> {
    const controls = await getSecurityControls(
      this.drizzle,
      userId,
      this.trustedDevices?.getTrustedDeviceDays() ?? 0,
    );
    if (!controls) {
      throw new UserNotFoundError(userId);
    }
    return controls;
  }

  private async expireSessionToken(token: string | null | undefined) {
    if (token) {
      await this.drizzle.db
        .update(session)
        .set({ expiresAt: new Date() })
        .where(eq(session.token, token));
    }
  }

  private async assertChallengedAccountNotBlocked(userId: User['id'], meta: ClientMeta) {
    const [account] = await this.drizzle.db
      .select({
        id: user.id,
        isActive: user.isActive,
        rgBlocked: user.rgBlocked,
        rgBlockedUntil: user.rgBlockedUntil,
      })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    if (account) {
      await this.assertAccountNotBlocked(account, meta);
    }
  }

  private assertAccountNotBlocked(
    account: { id: User['id']; isActive: boolean; rgBlocked: boolean; rgBlockedUntil: Date | null },
    meta: ClientMeta,
  ): Promise<string | null> {
    return assertAccountNotBlocked({ drizzle: this.drizzle, events: this.events }, account, meta, {
      revokeSessions: true,
      errorData: {
        rgBlocked: { code: 'RG_BLOCKED' },
        suspended: { code: 'ACCOUNT_SUSPENDED' },
        inactive: { code: 'ACCOUNT_INACTIVE' },
      },
    });
  }

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
    const { ip, userAgent } = extractClientMeta(reqHeaders);
    const meta = { ip, userAgent };
    const registration = this.platformConfig?.registration;
    const provisioning = this.playerProvisioning;
    if (!registration || !provisioning) {
      this.emitRegistrationFailed('registration_disabled', input, meta);
      throw new ORPCError('FORBIDDEN', { message: 'Registration is unavailable' });
    }
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
    const registrationGeo = this.geoCheck ? await this.geoCheck.checkAccess(ip) : null;
    if (registrationGeo && !registrationGeo.allowed) {
      this.emitRegistrationFailed('geo_blocked', input, meta);
      throw new ORPCError('FORBIDDEN', { message: 'Registration is unavailable' });
    }
    try {
      assertUsernameAllowed(input.username, this.platformConfig?.reservedUsernames);
    } catch (err) {
      this.emitRegistrationFailed('username_blocked', input, meta);
      throw err;
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
      const existingUserId = (await isUserInsertFailure(authResponse))
        ? await this.findUserIdByEmail(input.email)
        : null;
      if (existingUserId) {
        identityLogger.warn(
          { existingUserId, status: authResponse.status },
          'sign-up lost a concurrent same-email race - answered as a known address',
        );
        this.emitRegistrationFailed('email_already_registered', input, meta);
        return { status: 'check-email' as const };
      }
      if (await this.findUserIdByUsername(input.username)) {
        this.emitRegistrationFailed('username_taken', input, meta);
        throw new UsernameConflictError();
      }
      this.emitRegistrationFailed('error', input, meta);
      await ensureOk(authResponse, { genericMessage: 'Registration is unavailable' });
    }
    const body = (await authResponse.json()) as { user: BetterAuthUser };
    if ((await this.findUserIdByEmail(input.email)) !== body.user.id) {
      this.emitRegistrationFailed('email_already_registered', input, meta);
      return { status: 'check-email' as const };
    }
    await this.drizzle.db
      .update(user)
      .set({ passwordMeetsPolicy: true })
      .where(eq(user.id, body.user.id));
    const registered = (playerId: string | null, consentStored: boolean) => ({
      userId: body.user.id,
      playerId,
      countryCode: registrationGeo?.countryCode ?? null,
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
    let registeredEmitted = false;
    let playEligibilityPublished = false;
    let consent: Awaited<ReturnType<IdentityService['recordRegistrationConsent']>>;
    try {
      consent = await this.recordRegistrationConsent(
        provisioning,
        body.user.id,
        registration.termsVersion,
        { ip, userAgent },
        input.acquisition,
        async (tx, playerId) => {
          await this.events.emitInTransaction(
            tx,
            'identity.user.registered',
            registered(playerId, true),
          );
          registeredEmitted = true;
          await this.playEligibility.publish(tx as DrizzleTx, body.user.id);
          playEligibilityPublished = true;
        },
      );
    } catch (err) {
      this.emitRegistrationFailed('error', input, meta);
      throw err;
    }
    const { playerId, consentStored } = consent;
    await captureTimezone(this.playerProvisioning, body.user.id, input.timezone);
    if (!playEligibilityPublished) {
      await this.playEligibility.sync(body.user.id);
    }
    if (!registeredEmitted) {
      this.events.emit(
        'identity.user.registered',
        registered(
          playerId ?? (await this.identityReader.getPlayerIdByUserIdSafe(body.user.id)),
          consentStored,
        ),
      );
    }
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

  private async recordRegistrationConsent(
    provisioning: PlayerProvisioning,
    userId: User['id'],
    termsVersion: string,
    { ip, userAgent }: ClientMeta,
    acquisition: RegistrationAcquisition | undefined,
    onCreated: (tx: unknown, playerId: string) => Promise<void>,
  ) {
    const now = new Date();
    let outcome: Awaited<ReturnType<PlayerProvisioning['createForRegistration']>>;
    try {
      outcome = await provisioning.createForRegistration(
        {
          userId,
          termsVersion,
          termsAcceptedAt: now,
          ageAcceptedAt: now,
          registrationIp: ip,
          registrationUserAgent: userAgent,
          ...(acquisition ? { acquisition } : {}),
        },
        onCreated,
      );
    } catch (err) {
      identityLogger.error(
        { err, userId },
        'registration consent write failed - rolling back user',
      );
      await this.drizzle.db.delete(user).where(eq(user.id, userId));
      throw new ORPCError('INTERNAL_SERVER_ERROR', { message: 'Registration is unavailable' });
    }
    if (!outcome.created) {
      identityLogger.error(
        { userId, termsVersion },
        'registration consent not stored - player row already existed',
      );
    }
    return { playerId: outcome.playerId ?? null, consentStored: outcome.created };
  }

  registrationPolicy(): RegistrationPolicy {
    return { minPlayerAge: resolveMinPlayerAge(this.platformConfig) };
  }

  async usernameAvailable(username: string, reqHeaders: NodeHeaders) {
    const { ip } = extractClientMeta(reqHeaders);
    await assertRateLimit(
      this.limiter,
      `check-username:${ip ?? 'unknown'}`,
      USERNAME_AVAILABILITY_RATE_LIMIT,
    );
    return {
      available:
        isUsernameAllowed(username, this.platformConfig?.reservedUsernames) &&
        !(await this.findUserIdByUsername(username)),
    };
  }

  async login(input: LoginInput, reqHeaders: NodeHeaders, resHeaders: Headers) {
    const { ip, userAgent } = extractClientMeta(reqHeaders);
    const headers = nodeHeadersToHeaders(reqHeaders);
    const email = input.email.toLowerCase();

    const ipRateLimitOptions = this.options?.loginIpRateLimit;
    if (ipRateLimitOptions?.enabled ?? true) {
      await assertRateLimit(this.limiter, makeLoginIpRateLimitKey(ip ?? 'unknown'), {
        ...DEFAULT_LOGIN_IP_RATE_LIMIT,
        ...(ipRateLimitOptions?.limit !== undefined ? { limit: ipRateLimitOptions.limit } : {}),
        ...(ipRateLimitOptions?.windowMs !== undefined
          ? { windowMs: ipRateLimitOptions.windowMs }
          : {}),
      });
    }

    await assertRateLimit(this.limiter, makeLoginRateLimitKey(email), LOGIN_RATE_LIMIT);

    const configLockoutEnabled = this.options?.lockout?.enabled ?? true;
    const [existingUserRow] = await this.drizzle.db
      .select({
        id: user.id,
        isActive: user.isActive,
        failedLoginAttempts: user.failedLoginAttempts,
        lockoutUntil: user.lockoutUntil,
        lockoutCount: user.lockoutCount,
        lastLockoutAt: user.lastLockoutAt,
        lastFailedLoginAt: user.lastFailedLoginAt,
        role: user.role,
        rgBlocked: user.rgBlocked,
        rgBlockedUntil: user.rgBlockedUntil,
        requireTwoFactorOnLogin: user.requireTwoFactorOnLogin,
      })
      .from(user)
      .where(eq(user.email, email))
      .limit(1);
    let existingUser:
      | Pick<
          typeof user.$inferSelect,
          | 'id'
          | 'isActive'
          | 'failedLoginAttempts'
          | 'lockoutUntil'
          | 'lockoutCount'
          | 'lastLockoutAt'
          | 'lastFailedLoginAt'
          | 'role'
          | 'rgBlocked'
          | 'rgBlockedUntil'
          | 'requireTwoFactorOnLogin'
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

    let signInHeaders = headers;
    if (existingUser && this.trustedDevices && hasTrustDeviceCookie(headers)) {
      const trusted =
        !existingUser.requireTwoFactorOnLogin &&
        (await this.trustedDevices.isTrusted(existingUser.id, userAgent));
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

      const playerId = existingUser
        ? await this.assertAccountNotBlocked(existingUser, { ip, userAgent })
        : null;

      const body = (await authResponse.json()) as {
        user?: BetterAuthUser;
        token?: string;
        session?: { expiresAt: string | Date };
        twoFactorRedirect?: boolean;
      };

      await assertCountryAllowed(
        this.geoCheck,
        existingUser ?? NO_ROLE,
        ip,
        async (countryCode) => {
          await this.expireSessionToken(body.token);
          this.events.emit('identity.user.login.failed', {
            email,
            reason: 'geo_blocked',
            countryCode,
            ip,
            userAgent,
          });
        },
      );

      if (input.audience && existingUser && !matchesAudience(existingUser.role, input.audience)) {
        await this.expireSessionToken(body.token);
        this.events.emit('identity.user.login.failed', {
          email,
          reason: 'audience_mismatch',
          ip,
          userAgent,
        });
        throw new ORPCError('FORBIDDEN', {
          message: 'This account cannot sign in here.',
          data: { code: 'AUDIENCE_MISMATCH' },
        });
      }

      this.forwardCookies(authResponse, resHeaders);

      if (body.twoFactorRedirect || !body.user || !body.token) {
        return {
          twoFactorRedirect: true,
          trustedDeviceDays: this.trustedDevices?.getTrustedDeviceDays() ?? 0,
          ...(existingUser
            ? { twoFactorMethod: await this.resolveTwoFactorMethod(existingUser.id) }
            : {}),
        };
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
      this.events.emit('identity.authentication.succeeded', {
        userId: body.user.id,
        playerId,
        method: 'password',
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
      if (
        error instanceof ORPCError &&
        error.code === 'FORBIDDEN' &&
        (hasErrorCode(error, 'RG_BLOCKED') ||
          hasErrorCode(error, 'ACCOUNT_SUSPENDED') ||
          hasErrorCode(error, 'ACCOUNT_INACTIVE') ||
          hasErrorCode(error, 'GEO_BLOCKED') ||
          hasErrorCode(error, 'AUDIENCE_MISMATCH'))
      ) {
        throw error;
      }
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

  private adminPasswordResetMarkerKey(email: string): string {
    return `admin-password-reset:${email.toLowerCase()}`;
  }

  private async isAdminPasswordReset(email: string): Promise<boolean> {
    if (!this.cache) {
      return false;
    }
    const key = this.adminPasswordResetMarkerKey(email);
    try {
      const isAdmin = (await this.cache.get<boolean>(key)) === true;
      if (isAdmin) {
        await this.cache.delete(key);
      }
      return isAdmin;
    } catch (err) {
      identityLogger.warn({ err }, 'admin password reset marker cache read failed');
      return false;
    }
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

    await this.api
      .requestPasswordResetEmailOTP({
        body: { email },
        headers: new Headers(),
        asResponse: true,
      })
      .catch(() => undefined);

    this.events.emit('identity.password.admin_reset_requested', {
      userId,
      email,
      actorId,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    });

    return SUCCESS;
  }

  async findAccountRole(userId: User['id']) {
    const [row] = await this.drizzle.db
      .select({ role: user.role })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    return row?.role ?? null;
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

  async enableTwoFactor(
    input: Enable2faInput,
    reqHeaders: NodeHeaders,
    resHeaders: Headers,
  ): Promise<Enable2faResult> {
    const headers = nodeHeadersToHeaders(reqHeaders);
    const userId = await this.currentUserId(headers);
    await assertRateLimit(
      this.limiter,
      `enable2fa:${userId ?? 'anonymous'}`,
      TWO_FACTOR_PASSWORD_RATE_LIMIT,
    );
    if (!userId) {
      throw new ORPCError('UNAUTHORIZED', { message: 'Not signed in' });
    }
    await this.assertMethodAvailable(userId, input.method);

    if (await this.isTwoFactorEnabled(userId)) {
      throw new ORPCError('CONFLICT', {
        message: 'Two-factor authentication is already enabled. Disable it first to change method.',
      });
    }

    const res = await this.api.enableTwoFactor({
      body: { password: input.password },
      headers,
      asResponse: true,
    });
    await ensureOk(res);
    this.forwardCookies(res, resHeaders);
    const body = (await res.json()) as { totpURI: string; backupCodes: string[] };

    await this.setTwoFactorMethod(userId, input.method);
    if (input.method === 'app') {
      return { totpUri: body.totpURI, backupCodes: body.backupCodes };
    }

    const masked = await this.sendOtpForCurrentMethod(userId, headers, resHeaders);
    return { backupCodes: body.backupCodes, maskedDestination: masked };
  }

  async sendTwoFactorOtp(reqHeaders: NodeHeaders, resHeaders: Headers) {
    const headers = nodeHeadersToHeaders(reqHeaders);
    const pendingCookie = await this.twoFactorPendingCookie(headers);
    const userId =
      (await this.currentUserId(headers)) ??
      (await this.twoFactorLockout?.resolvePendingUserId(pendingCookie));
    if (!userId) {
      throw new ORPCError('UNAUTHORIZED', { message: 'Not signed in' });
    }
    await assertRateLimit(this.limiter, `send2faOtp:${userId}`, SEND_2FA_OTP_RATE_LIMIT);
    await this.twoFactorLockout?.assertNotLocked(userId);
    return { maskedDestination: await this.sendOtpForCurrentMethod(userId, headers, resHeaders) };
  }

  async twoFactorStatus(reqHeaders: NodeHeaders): Promise<TwoFactorStatus> {
    const headers = nodeHeadersToHeaders(reqHeaders);
    const userId = await this.currentUserId(headers);
    if (!userId) {
      throw new ORPCError('UNAUTHORIZED', { message: 'Not signed in' });
    }
    const [row] = await this.drizzle.db
      .select({
        email: user.email,
        phoneNumber: user.phoneNumber,
        phoneVerified: user.phoneVerified,
        twoFactorEnabled: user.twoFactorEnabled,
        twoFactorMethod: user.twoFactorMethod,
      })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    if (!row) {
      throw new UserNotFoundError(userId);
    }
    const enabled = row.twoFactorEnabled ?? false;
    return {
      enabled,
      method: enabled ? (row.twoFactorMethod ?? null) : null,
      maskedEmail: maskEmail(row.email),
      maskedPhone: row.phoneVerified && row.phoneNumber ? maskPhone(row.phoneNumber) : null,
      backupCodesRemaining: enabled ? await countRemainingBackupCodes(this.auth, userId) : null,
    };
  }

  private async assertMethodAvailable(
    userId: User['id'],
    method: TwoFactorDeliveryMethod,
  ): Promise<void> {
    if (method === 'app') {
      return;
    }
    const [row] = await this.drizzle.db
      .select({
        emailVerified: user.emailVerified,
        phoneNumber: user.phoneNumber,
        phoneVerified: user.phoneVerified,
      })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    if (method === 'email' && !row?.emailVerified) {
      throw new ORPCError('BAD_REQUEST', {
        message: 'Verify your email address before using email for two-factor authentication',
      });
    }
    if (method === 'sms' && (!row?.phoneNumber || !row.phoneVerified)) {
      throw new ORPCError('BAD_REQUEST', {
        message: 'Add and verify a phone number before using SMS for two-factor authentication',
      });
    }
  }

  private async resolveTwoFactorMethod(userId: User['id']): Promise<TwoFactorDeliveryMethod> {
    const [row] = await this.drizzle.db
      .select({ twoFactorMethod: user.twoFactorMethod })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    return row?.twoFactorMethod ?? 'app';
  }

  private async isTwoFactorEnabled(userId: User['id']): Promise<boolean> {
    const [row] = await this.drizzle.db
      .select({ twoFactorEnabled: user.twoFactorEnabled })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    return row?.twoFactorEnabled ?? false;
  }

  private async setTwoFactorMethod(
    userId: User['id'],
    method: TwoFactorDeliveryMethod | null,
  ): Promise<void> {
    await this.drizzle.db.update(user).set({ twoFactorMethod: method }).where(eq(user.id, userId));
  }

  private verifyChallengeCode(
    method: TwoFactorChallengeMethod,
    body: { code: string; trustDevice: boolean },
    headers: Headers,
  ): Promise<globalThis.Response> {
    return verifyChallengeCode(this.api, method, body, headers);
  }

  private async sendOtpForCurrentMethod(
    userId: User['id'],
    headers: Headers,
    resHeaders: Headers,
  ): Promise<string> {
    const destination = await this.twoFactorDelivery.describeDestination(userId);
    if (!destination) {
      throw new ORPCError('BAD_REQUEST', {
        message: 'This account does not receive two-factor codes by email or SMS',
      });
    }
    const res = await this.api.sendTwoFactorOTP({ body: {}, headers, asResponse: true });
    await ensureOk(res);
    const failure = this.twoFactorDelivery.takeFailure(userId);
    if (failure) {
      throw new ORPCError('SERVICE_UNAVAILABLE', {
        message: 'Could not send your verification code. Please try again.',
        cause: failure,
      });
    }
    this.forwardCookies(res, resHeaders);
    return destination.masked;
  }

  private async requiresTwoFactorEveryLogin(
    userId: User['id'] | null | undefined,
  ): Promise<boolean> {
    if (!userId) {
      return false;
    }
    const [row] = await this.drizzle.db
      .select({ requireTwoFactorOnLogin: user.requireTwoFactorOnLogin })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    return row?.requireTwoFactorOnLogin ?? false;
  }

  private async twoFactorPendingCookie(headers: Headers) {
    const { name } = (await this.auth.$context).createAuthCookie('two_factor');
    return twoFactorPendingCookieValue(headers, name);
  }

  private async accountRole(userId: User['id']) {
    const [row] = await this.drizzle.db
      .select({ role: user.role })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    return row ?? NO_ROLE;
  }

  async verifyTwoFactor(input: Verify2faInput, reqHeaders: NodeHeaders, resHeaders: Headers) {
    const { ip, userAgent } = extractClientMeta(reqHeaders);
    const headers = nodeHeadersToHeaders(reqHeaders);
    const pendingCookie = await this.twoFactorPendingCookie(headers);
    const sessionUserId = await this.currentUserId(headers);
    const twoFactorKey = sessionUserId ?? pendingCookie ?? 'anonymous';
    await assertRateLimit(this.limiter, `verify2fa:${twoFactorKey}`, VERIFY_2FA_RATE_LIMIT);

    const challengedUserId =
      sessionUserId ?? (await this.twoFactorLockout?.resolvePendingUserId(pendingCookie));
    if (challengedUserId) {
      await this.twoFactorLockout?.assertNotLocked(challengedUserId);
    }
    if (challengedUserId && !sessionUserId) {
      await assertCountryAllowed(this.geoCheck, await this.accountRole(challengedUserId), ip);
    }

    const trustDevice =
      input.trustDevice &&
      input.method !== 'backup_code' &&
      this.trustedDevices !== undefined &&
      !(await this.requiresTwoFactorEveryLogin(challengedUserId));
    const body = { code: input.code, trustDevice };
    const res = await this.verifyChallengeCode(input.method, body, headers);
    if (!res.ok && challengedUserId && !isLostBackupCodeRace(res)) {
      await this.twoFactorLockout?.recordFailure(challengedUserId, input.method, {
        ip,
        userAgent,
      });
    }
    await ensureOk(res);
    if (!sessionUserId) {
      const verification = TwoFactorVerificationResponseSchema.safeParse(
        await res
          .clone()
          .json()
          .catch(() => undefined),
      );
      if (!verification.success) {
        throw new ORPCError('UNAUTHORIZED', { message: 'Invalid two-factor challenge' });
      }
      if (!challengedUserId || verification.data.user?.id !== challengedUserId) {
        await this.drizzle.db.delete(session).where(eq(session.token, verification.data.token));
        throw new ORPCError('UNAUTHORIZED', { message: 'Invalid two-factor challenge' });
      }
    }
    if (challengedUserId && !sessionUserId) {
      await this.assertChallengedAccountNotBlocked(challengedUserId, { ip, userAgent });
    }
    if (challengedUserId) {
      await this.twoFactorLockout?.reset(challengedUserId);
    }
    this.forwardCookies(res, resHeaders);
    const userId = challengedUserId ?? (await this.currentUserId(headers));
    let trustGranted = false;
    if (userId) {
      const playerId = await this.identityReader.getPlayerIdByUserIdSafe(userId);
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
      if (!sessionUserId) {
        this.events.emit('identity.authentication.succeeded', {
          userId,
          playerId,
          method: input.method,
          ip,
          userAgent,
        });
      }
      if (trustDevice) {
        await this.trustedDevices?.trust(userId, { ip, userAgent });
        trustGranted = true;
      }
      await captureTimezone(this.playerProvisioning, userId, input.timezone);
    }
    return { ...SUCCESS, trustGranted };
  }

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
    if (await this.requiresTwoFactorEveryLogin(userId)) {
      throw new ORPCError('UNPROCESSABLE_CONTENT', {
        message: 'Turn off two-factor on every login before trusting this device.',
      });
    }

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

    const challengeHeaders = new Headers(headers);
    challengeHeaders.set('cookie', requestCookieHeader(signIn));

    await this.twoFactorLockout?.assertNotLocked(userId);

    const challengeMethod = await resolveChallengeMethod(this.drizzle, userId);
    if (challengeMethod !== 'totp') {
      throw new ORPCError('CONFLICT', {
        message: 'Trusting this device requires an authenticator app.',
      });
    }
    const verified = await this.verifyChallengeCode(
      challengeMethod,
      { code: input.code, trustDevice: true },
      challengeHeaders,
    );
    if (!verified.ok) {
      await this.twoFactorLockout?.recordFailure(userId, challengeMethod, { ip, userAgent });
    }
    await ensureOk(verified);
    await this.twoFactorLockout?.reset(userId);

    this.forwardCookies(verified, resHeaders);
    await this.trustedDevices?.trust(userId, { ip, userAgent });
    const playerId = await this.identityReader.getPlayerIdByUserIdSafe(userId);
    this.events.emit('identity.2fa.verified', {
      userId,
      playerId,
      method: challengeMethod,
      trustedDevice: true,
      ip,
      userAgent,
    });
    this.events.emit('identity.authentication.succeeded', {
      userId,
      playerId,
      method: 'totp',
      ip,
      userAgent,
    });
    return SUCCESS;
  }

  private async assertFreshSecondFactor({
    userId,
    headers,
    meta,
    password,
    code,
    method,
  }: {
    userId: User['id'];
    headers: Headers;
    meta: ClientMeta;
    password: string;
    code: string;
    method: StepUpMethod;
  }): Promise<TwoFactorChallengeMethod> {
    await this.twoFactorLockout?.assertNotLocked(userId);
    const challengeMethod =
      method === 'backup_code' ? 'backup_code' : await resolveChallengeMethod(this.drizzle, userId);
    if (challengeMethod === 'backup_code') {
      try {
        await assertAccountPassword({ drizzle: this.drizzle, auth: this.auth, userId, password });
      } catch (err) {
        await this.twoFactorLockout?.recordFailure(userId, challengeMethod, meta);
        throw err;
      }
    }
    const res = await this.verifyChallengeCode(
      challengeMethod,
      { code, trustDevice: false },
      headers,
    );
    if (isLostBackupCodeRace(res)) {
      throw new ORPCError('CONFLICT', { message: 'This backup code has just been used.' });
    }
    if (!res.ok) {
      await this.twoFactorLockout?.recordFailure(userId, challengeMethod, meta);
    }
    await ensureOk(res, { genericMessage: 'Invalid authenticator code' });
    await this.twoFactorLockout?.reset(userId);
    this.events.emit('identity.2fa.verified', {
      userId,
      playerId: await this.identityReader.getPlayerIdByUserIdSafe(userId),
      method: challengeMethod,
      trustedDevice: false,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    });
    return challengeMethod;
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
    const stepUpMethod = await this.assertFreshSecondFactor({
      userId,
      headers,
      meta: { ip, userAgent },
      password: input.password,
      code: input.code,
      method: 'live',
    });

    const res = await this.api.generateBackupCodes({
      body: { password: input.password },
      headers,
      asResponse: true,
    });
    await ensureOk(res);
    this.forwardCookies(res, resHeaders);
    const body = (await res.json()) as { backupCodes: string[] };

    await this.trustedDevices?.revokeAllForUser(userId, userId);

    this.events.emit('identity.2fa.backup_codes_regenerated', {
      userId,
      playerId: await this.identityReader.getPlayerIdByUserIdSafe(userId),
      stepUpMethod,
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
    const stepUpMethod = await this.assertFreshSecondFactor({
      userId,
      headers,
      meta: { ip, userAgent },
      password: input.password,
      code: input.code,
      method: input.method,
    });

    const disabledMethod = await resolveChallengeMethod(this.drizzle, userId);

    const res = await this.api.disableTwoFactor({
      body: { password: input.password },
      headers,
      asResponse: true,
    });
    await ensureOk(res);
    this.forwardCookies(res, resHeaders);
    await this.setTwoFactorMethod(userId, null);

    await this.trustedDevices?.revokeAllForUser(userId, userId);
    await this.sessions?.revokeAllSessions(userId, userId, { ip, userAgent });
    await this.drizzle.db
      .update(user)
      .set({ requireTwoFactorOnLogin: false })
      .where(eq(user.id, userId));

    this.events.emit('identity.2fa.disabled', {
      userId,
      playerId: await this.identityReader.getPlayerIdByUserIdSafe(userId),
      method: disabledMethod,
      stepUpMethod,
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
    await this.api
      .requestPasswordResetEmailOTP({
        body: { email },
        headers: new Headers(),
        asResponse: true,
      })
      .catch(() => undefined);
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

    return SUCCESS;
  }

  async changePassword(
    input: ChangePasswordInput,
    reqHeaders: NodeHeaders,
    resHeaders: Headers,
    caller: { userId: User['id']; sessionId: Session['id'] },
  ) {
    const headers = nodeHeadersToHeaders(reqHeaders);
    const { userId, sessionId } = caller;
    await assertRateLimit(this.limiter, `change-password:${userId}`, CHANGE_PASSWORD_RATE_LIMIT);
    const res = await this.api.changePassword({
      body: {
        currentPassword: input.currentPassword,
        newPassword: input.newPassword,
        revokeOtherSessions: true,
      },
      headers,
      asResponse: true,
    });
    await ensureOk(res);
    this.forwardCookies(res, resHeaders);
    const sweepDeadline = new Date();
    const rotatedToken =
      ((await res.json().catch(() => ({}))) as { token?: string | null }).token ?? null;
    const rotated = rotatedToken
      ? (
          await this.drizzle.db
            .select({ id: session.id })
            .from(session)
            .where(eq(session.token, rotatedToken))
            .limit(1)
        )[0]
      : undefined;
    if (rotated && hasDontRememberCookie(headers)) {
      await this.drizzle.db
        .update(session)
        .set({ expiresAt: new Date(Date.now() + DONT_REMEMBER_SESSION_TTL_MS) })
        .where(eq(session.id, rotated.id));
    }
    const { ip, userAgent } = extractClientMeta(reqHeaders);
    const [, playerId] = await Promise.all([
      this.drizzle.db.update(user).set({ passwordMeetsPolicy: true }).where(eq(user.id, userId)),
      this.identityReader.getPlayerIdByUserIdSafe(userId),
    ]);
    this.events.emit('identity.password.changed', {
      userId,
      playerId,
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
    this.events.emit('identity.sessions.revoked_all', {
      userId,
      playerId,
      actorId: userId,
      ip: ip ?? null,
      userAgent: userAgent ?? null,
      exceptSessionId: sessionId,
    });
    if (rotatedToken) {
      const timer = setTimeout(() => {
        void sweepRacedSessionsAfterPasswordChange(this.drizzle.db, {
          userId,
          sparedToken: rotatedToken,
          deadline: sweepDeadline,
        })
          .then((deletedIds) => {
            if (deletedIds.length === 0) {
              return;
            }
            this.events.emit('identity.sessions.revoked_all', {
              userId,
              playerId,
              actorId: userId,
              ip: ip ?? null,
              userAgent: userAgent ?? null,
              exceptSessionId: sessionId,
            });
          })
          .catch((err: unknown) => {
            identityLogger.warn({ err, userId }, 'post-password-change session sweep failed');
          });
      }, RACED_SESSION_SWEEP_DELAY_MS);
      timer.unref?.();
    }
    await this.revokeMcpTokensAfterCredentialChange(userId, { ip, userAgent });
    return SUCCESS;
  }

  async getSecurityControls(reqHeaders: NodeHeaders): Promise<SecurityControls> {
    const userId = await this.currentUserId(nodeHeadersToHeaders(reqHeaders));
    if (!userId) {
      throw new ORPCError('UNAUTHORIZED', { message: 'Not signed in.' });
    }
    return this.securityControlsFor(userId);
  }

  private async assertPlayerPreferenceCaller(
    reqHeaders: NodeHeaders,
    resource: string,
  ): Promise<{ userId: string } & ClientMeta> {
    const { ip, userAgent } = extractClientMeta(reqHeaders);
    const userId = await this.currentUserId(nodeHeadersToHeaders(reqHeaders));
    if (!userId) {
      throw new ORPCError('UNAUTHORIZED', { message: 'Not signed in.' });
    }
    const [caller] = await this.drizzle.db
      .select({ role: user.role })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    if (caller?.role !== 'player') {
      this.events.emit('identity.user.unauthorized_access', {
        userId,
        playerId: null,
        resource,
        action: 'set',
        ...(caller?.role ? { role: caller.role } : {}),
        ip,
        userAgent,
      });
      throw new ORPCError('FORBIDDEN', {
        message: 'Only players can set this preference.',
      });
    }
    return { userId, ip, userAgent };
  }

  async setLoginWithdrawalAlerts(
    input: SetLoginWithdrawalAlertsInput,
    reqHeaders: NodeHeaders,
  ): Promise<SecurityControls> {
    const { userId, ip, userAgent } = await this.assertPlayerPreferenceCaller(
      reqHeaders,
      'identity.security.login_withdrawal_alerts',
    );
    const before = await this.securityControlsFor(userId);
    if (input.enabled && !before.emailVerified) {
      throw new ORPCError('UNPROCESSABLE_CONTENT', {
        message: 'Verify your email before enabling security alerts.',
      });
    }
    if (before.loginWithdrawalAlertsEnabled === input.enabled) {
      return before;
    }
    await this.drizzle.db
      .update(user)
      .set({ loginWithdrawalAlertsEnabled: input.enabled })
      .where(eq(user.id, userId));
    this.events.emit('identity.security.login_withdrawal_alerts.updated', {
      userId,
      playerId: await this.identityReader.getPlayerIdByUserIdSafe(userId),
      previousEnabled: before.loginWithdrawalAlertsEnabled,
      enabled: input.enabled,
      ip,
      userAgent,
    });
    return { ...before, loginWithdrawalAlertsEnabled: input.enabled };
  }

  async setAutoLogoutDuration(
    input: SetAutoLogoutInput,
    reqHeaders: NodeHeaders,
  ): Promise<SecurityControls> {
    const { userId, ip, userAgent } = await this.assertPlayerPreferenceCaller(
      reqHeaders,
      'identity.security.auto_logout',
    );
    const before = await this.securityControlsFor(userId);
    if (before.autoLogoutDuration === input.duration) {
      return before;
    }
    await this.drizzle.db
      .update(user)
      .set({ autoLogoutDuration: input.duration })
      .where(eq(user.id, userId));
    this.events.emit('identity.security.auto_logout.updated', {
      userId,
      playerId: await this.identityReader.getPlayerIdByUserIdSafe(userId),
      previousDuration: before.autoLogoutDuration,
      duration: input.duration,
      ip,
      userAgent,
    });
    return { ...before, autoLogoutDuration: input.duration };
  }

  async setRequireTwoFactorOnLogin(
    input: SetRequireTwoFactorOnLoginInput,
    reqHeaders: NodeHeaders,
  ): Promise<SecurityControls> {
    const { userId, ip, userAgent } = await this.assertPlayerPreferenceCaller(
      reqHeaders,
      'identity.security.require_two_factor',
    );
    const before = await this.securityControlsFor(userId);
    if (input.enabled && !before.twoFactorEnabled) {
      throw new ORPCError('UNPROCESSABLE_CONTENT', {
        message: 'Enable two-factor authentication before requiring it on every login.',
      });
    }
    if (before.requireTwoFactorOnLogin === input.enabled) {
      return before;
    }
    await this.drizzle.db
      .update(user)
      .set({ requireTwoFactorOnLogin: input.enabled })
      .where(eq(user.id, userId));
    if (input.enabled) {
      await this.trustedDevices?.revokeAllForUser(userId, userId);
    }
    this.events.emit('identity.security.require_two_factor.updated', {
      userId,
      playerId: await this.identityReader.getPlayerIdByUserIdSafe(userId),
      previousEnabled: before.requireTwoFactorOnLogin,
      enabled: input.enabled,
      ip,
      userAgent,
    });
    return { ...before, requireTwoFactorOnLogin: input.enabled };
  }

  async setAntiPhishingCode(
    input: SetAntiPhishingCodeInput,
    reqHeaders: NodeHeaders,
  ): Promise<SecurityControls> {
    const { ip, userAgent } = extractClientMeta(reqHeaders);
    const userId = await this.currentUserId(nodeHeadersToHeaders(reqHeaders));
    if (!userId) {
      throw new ORPCError('UNAUTHORIZED', { message: 'Not signed in.' });
    }
    const [caller] = await this.drizzle.db
      .select({ role: user.role, email: user.email, language: user.language })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    if (caller?.role !== 'player') {
      this.events.emit('identity.user.unauthorized_access', {
        userId,
        playerId: null,
        resource: 'identity.security.anti_phishing_code',
        action: 'set',
        ...(caller?.role ? { role: caller.role } : {}),
        ip,
        userAgent,
      });
      throw new ORPCError('FORBIDDEN', {
        message: 'Only players can set this preference.',
      });
    }
    const before = await this.securityControlsFor(userId);
    if (before.antiPhishingCode === input.code) {
      return before;
    }
    await assertRateLimit(
      this.limiter,
      makeRateLimitKey(RATE_LIMIT_KEYS.ANTI_PHISHING_CODE_MUTATION, userId),
      ANTI_PHISHING_CODE_RATE_LIMIT,
    );
    await this.drizzle.db
      .update(user)
      .set({ antiPhishingCode: input.code })
      .where(eq(user.id, userId));
    this.events.emit('identity.security.anti_phishing_code.set', {
      userId,
      playerId: await this.identityReader.getPlayerIdByUserIdSafe(userId),
      wasAlreadySet: before.antiPhishingCode !== null,
      ip,
      userAgent,
    });
    try {
      await this.mailDispatch?.toAddress({
        email: caller.email,
        locale: caller.language,
        template: {
          key: 'securityAntiPhishingCodeChanged',
          data: { previousAntiPhishingCode: before.antiPhishingCode },
        },
        idempotencyKey: `anti-phishing-code-changed:${userId}:${randomUUID()}`,
      });
    } catch (err) {
      identityLogger.error({ err, userId }, 'anti-phishing code change notice enqueue failed');
    }
    return { ...before, antiPhishingCode: input.code };
  }

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

  async verifyEmail(input: VerifyEmailInput, reqHeaders: NodeHeaders, resHeaders: Headers) {
    const { ip, userAgent } = extractClientMeta(reqHeaders);
    const headers = nodeHeadersToHeaders(reqHeaders);
    const email = input.email.toLowerCase();
    await assertRateLimit(this.limiter, `verify-email:${email}`, VERIFY_EMAIL_RATE_LIMIT);
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

    const playerId = await this.identityReader.getPlayerIdByUserIdSafe(body.user.id);
    this.events.emit('identity.email.verified', { userId: body.user.id, playerId, ip, userAgent });

    const [account] = await this.drizzle.db
      .select({
        id: user.id,
        isActive: user.isActive,
        rgBlocked: user.rgBlocked,
        rgBlockedUntil: user.rgBlockedUntil,
        twoFactorEnabled: user.twoFactorEnabled,
        role: user.role,
      })
      .from(user)
      .where(eq(user.id, body.user.id))
      .limit(1);
    if (account) {
      await this.assertAccountNotBlocked(account, { ip, userAgent });
    }
    await assertCountryAllowed(this.geoCheck, account ?? NO_ROLE, ip, () =>
      this.expireSessionToken(body.token),
    );
    await captureTimezone(this.playerProvisioning, body.user.id, input.timezone);

    if (account?.twoFactorEnabled) {
      await this.expireSessionToken(body.token);
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
    this.events.emit('identity.authentication.succeeded', {
      userId: body.user.id,
      playerId,
      method: 'email_verification',
      ip,
      userAgent,
    });

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

  async requestEmailChange(
    input: RequestEmailChangeInput,
    reqHeaders: NodeHeaders,
    resHeaders: Headers,
  ) {
    const headers = nodeHeadersToHeaders(reqHeaders);
    const meta = extractClientMeta(reqHeaders);
    const { ip } = meta;
    const userId = await this.currentUserId(headers);
    await assertRateLimit(
      this.limiter,
      `change-email:${userId ?? 'anonymous'}`,
      EMAIL_VERIFICATION_RATE_LIMIT,
    );
    if (!userId) {
      throw new ORPCError('UNAUTHORIZED', { message: 'Not signed in.' });
    }
    const newEmail = input.newEmail.toLowerCase();
    await assertRateLimit(
      this.limiter,
      `change-email-target:${userId}:${newEmail}`,
      EMAIL_VERIFICATION_RATE_LIMIT,
    );
    if (ip) {
      await assertRateLimit(this.limiter, `change-email-ip:${ip}`, EMAIL_VERIFICATION_RATE_LIMIT);
    }
    const [caller] = await this.drizzle.db
      .select({ twoFactorEnabled: user.twoFactorEnabled })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    if (!caller) {
      throw new ORPCError('UNAUTHORIZED', { message: 'Not signed in.' });
    }
    await assertFreshReauthentication({
      drizzle: this.drizzle,
      auth: this.auth,
      twoFactorLockout: this.twoFactorLockout,
      userId,
      headers,
      currentPassword: input.currentPassword,
      totpCode: input.totpCode,
      twoFactorEnabled: caller.twoFactorEnabled ?? false,
      meta,
    });
    const res = await this.api.requestEmailChangeEmailOTP({
      body: { newEmail: input.newEmail },
      headers,
      asResponse: true,
    });
    await ensureOk(res);
    this.forwardCookies(res, resHeaders);
    return SUCCESS;
  }

  async confirmEmailChange(
    input: ConfirmEmailChangeInput,
    reqHeaders: NodeHeaders,
    resHeaders: Headers,
  ) {
    const headers = nodeHeadersToHeaders(reqHeaders);
    const meta = extractClientMeta(reqHeaders);
    const { ip, userAgent } = meta;
    const userId = await this.currentUserId(headers);
    await assertRateLimit(
      this.limiter,
      `confirm-email-change:${userId ?? 'anonymous'}`,
      VERIFY_EMAIL_RATE_LIMIT,
    );
    if (!userId) {
      throw new ORPCError('UNAUTHORIZED', { message: 'Not signed in.' });
    }
    const newEmail = input.newEmail.toLowerCase();
    await assertRateLimit(
      this.limiter,
      `confirm-email-change-target:${userId}:${newEmail}`,
      VERIFY_EMAIL_RATE_LIMIT,
    );
    if (ip) {
      await assertRateLimit(this.limiter, `confirm-email-change-ip:${ip}`, VERIFY_EMAIL_RATE_LIMIT);
    }
    const playerId = await this.identityReader.getPlayerIdByUserIdSafe(userId);
    const { res, before, changedAt } = await this.drizzle.db.transaction(async (tx) => {
      const before = findOneOrThrow(
        await tx
          .select({
            email: user.email,
            language: user.language,
            name: user.username,
            antiPhishingCode: user.antiPhishingCode,
            loginWithdrawalAlertsEnabled: user.loginWithdrawalAlertsEnabled,
          })
          .from(user)
          .where(eq(user.id, userId))
          .for('no key update'),
        new ORPCError('UNAUTHORIZED', { message: 'Not signed in.' }),
      );
      const changedAt = new Date().toISOString();
      const res = await runInAuthTransaction(tx, { auth: this.auth, schema: AUTH_SCHEMA }, () =>
        this.api.changeEmailEmailOTP({
          body: { newEmail: input.newEmail, otp: input.otp },
          headers,
          asResponse: true,
        }),
      );
      if (!res.ok) {
        const [after] = await tx
          .select({ email: user.email })
          .from(user)
          .where(eq(user.id, userId));
        if (after?.email !== before.email) {
          throw new EmailChangeWithoutHistoryError();
        }
        return { res, before, changedAt };
      }
      await tx
        .delete(verification)
        .where(like(verification.identifier, pendingEmailChangeIdentifierPattern(userId)));
      await this.audit.recordInTransaction(tx, {
        actorType: playerId ? 'player' : 'admin',
        actorId: playerId ?? userId,
        action: 'identity.email.changed',
        resourceType: playerId ? 'player' : 'user',
        resourceId: playerId ?? userId,
        before: { email: before.email },
        after: { email: newEmail, changedAt },
        result: 'success',
        ip,
        userAgent,
      });
      await this.events.emitInTransaction(tx, 'identity.email.changed', {
        userId,
        playerId,
        previousEmail: before.email,
        newEmail,
        changedAt,
        ip,
        userAgent,
        auditRecorded: true,
      });
      return { res, before, changedAt };
    });
    await ensureOk(res, { genericMessage: 'Invalid or expired verification code' });
    this.forwardCookies(res, resHeaders);

    this.mailDispatch
      ?.toAddress({
        email: before.email,
        locale: before.language,
        antiPhishingCode: before.antiPhishingCode,
        recipientName: before.name,
        template: {
          key: 'emailChanged',
          data: { newEmail, occurredAt: changedAt, isNewAddress: false },
        },
        idempotencyKey: `email-change-notice-old:${userId}:${randomUUID()}`,
      })
      .catch((err: unknown) =>
        identityLogger.error({ err, userId }, 'email-change notice (old address) enqueue failed'),
      );
    this.mailDispatch
      ?.toAddress({
        email: newEmail,
        locale: before.language,
        antiPhishingCode: before.antiPhishingCode,
        recipientName: before.name,
        template: {
          key: 'emailChanged',
          data: { newEmail, occurredAt: changedAt, isNewAddress: true },
        },
        idempotencyKey: `email-change-notice-new:${userId}:${randomUUID()}`,
      })
      .catch((err: unknown) =>
        identityLogger.error({ err, userId }, 'email-change notice (new address) enqueue failed'),
      );
    await this.trustedDevices?.revokeAllForUser(userId, userId);
    await this.sessions?.revokeAllSessions(userId, userId, meta);
    if (before.loginWithdrawalAlertsEnabled) {
      await this.drizzle.db
        .update(user)
        .set({ loginWithdrawalAlertsEnabled: false })
        .where(eq(user.id, userId));
      this.events.emit('identity.security.login_withdrawal_alerts.updated', {
        userId,
        playerId,
        previousEnabled: true,
        enabled: false,
        ip,
        userAgent,
      });
    }
    return SUCCESS;
  }

  async updateProfile(input: UpdateProfileInput, reqHeaders: NodeHeaders, resHeaders: Headers) {
    if (input.language !== undefined) {
      assertSupportedLanguage(input.language, this.platformConfig);
    }
    if (
      typeof input.image === 'string' &&
      !isAllowedAvatarUrl(input.image, this.platformConfig?.identity)
    ) {
      throw new AvatarHostNotAllowedError();
    }
    const { ip, userAgent } = extractClientMeta(reqHeaders);
    const headers = nodeHeadersToHeaders(reqHeaders);
    const { name, image, theme, language } = input;
    const res = await this.api.updateUser({
      body: { name, image, theme, language },
      headers,
      asResponse: true,
    });
    await ensureOk(res);
    this.forwardCookies(res, resHeaders);
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

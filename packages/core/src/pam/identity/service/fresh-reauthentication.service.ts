import { ORPCError } from '@orpc/server';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { Auth, DrizzleService } from '@openora/core/server';
import type { ClientMeta, User } from '@openora/core/contracts';
import { account } from '../schema/index.js';
import type { TwoFactorLockoutService } from './two-factor-lockout.service.js';

type VerifyTotpApi = {
  verifyTOTP(opts: {
    body: { code: string; trustDevice: false };
    headers: Headers;
    asResponse: true;
  }): Promise<Response>;
};

/**
 * Requires the account's standing password plus (when 2FA is enrolled) a fresh
 * authenticator code before a security-sensitive self-service action proceeds. Shared by
 * every route that gates a mutation on "prove you're still you right now" - phone
 * verification and the withdrawal PIN both call this instead of re-deriving it.
 */
export async function assertFreshReauthentication({
  drizzle,
  auth,
  twoFactorLockout,
  userId,
  headers,
  currentPassword,
  totpCode,
  twoFactorEnabled,
  meta,
}: {
  drizzle: DrizzleService;
  auth: Auth;
  twoFactorLockout?: TwoFactorLockoutService;
  userId: User['id'];
  headers: Headers;
  currentPassword: string;
  totpCode: string | undefined;
  twoFactorEnabled: boolean;
  meta: ClientMeta;
}): Promise<void> {
  const [credential] = await drizzle.db
    .select({ password: account.password })
    .from(account)
    .where(and(eq(account.userId, userId), isNotNull(account.password)))
    .limit(1);
  if (!credential?.password) {
    throw new ORPCError('UNAUTHORIZED', { message: 'Current password is invalid.' });
  }

  const authContext = await auth.$context;
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

  await twoFactorLockout?.assertNotLocked(userId);
  // Library boundary: the base Auth API type omits endpoints contributed by the
  // twoFactor plugin, but createAuth always installs that plugin for identity.
  const api = auth.api as unknown as VerifyTotpApi;
  const verification = await api.verifyTOTP({
    body: { code: totpCode, trustDevice: false },
    headers,
    asResponse: true,
  });
  if (!verification.ok) {
    await twoFactorLockout?.recordFailure(userId, meta);
    throw new ORPCError('UNAUTHORIZED', { message: 'Invalid authenticator code.' });
  }
  await twoFactorLockout?.reset(userId);
}

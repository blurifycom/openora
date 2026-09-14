import { ORPCError } from '@orpc/server';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { Auth, DrizzleService } from '@openora/core/server';
import type { ClientMeta, User } from '@openora/core/contracts';
import { account } from '../schema/index.js';
import type { TwoFactorLockoutService } from './two-factor-lockout.service.js';
import {
  resolveChallengeMethod,
  verifyChallengeCode,
  type TwoFactorVerifyApi,
} from './two-factor-challenge.service.js';

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
      message: 'A second-factor code is required.',
    });
  }

  await twoFactorLockout?.assertNotLocked(userId);
  const api = auth.api as unknown as TwoFactorVerifyApi;
  const verification = await verifyChallengeCode(
    api,
    await resolveChallengeMethod(drizzle, userId),
    { code: totpCode, trustDevice: false },
    headers,
  );
  if (!verification.ok) {
    await twoFactorLockout?.recordFailure(userId, meta);
    throw new ORPCError('UNAUTHORIZED', { message: 'Invalid second-factor code.' });
  }
  await twoFactorLockout?.reset(userId);
}

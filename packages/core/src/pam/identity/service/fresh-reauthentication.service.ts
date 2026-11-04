import { ORPCError } from '@orpc/server';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { Auth, DrizzleService } from '@openora/core/server';
import type {
  ClientMeta,
  FreshReauthentication,
  FreshReauthenticationVerdict,
  User,
} from '@openora/core/contracts';
import { account, user } from '../schema/index.js';
import { nodeHeadersToHeaders } from '../../shared/headers-mapper.js';
import { isActiveLockout } from './lockout-policy.service.js';
import type { TwoFactorLockoutService } from './two-factor-lockout.service.js';
import {
  resolveChallengeMethod,
  verifyChallengeCode,
  type TwoFactorVerifyApi,
} from './two-factor-challenge.service.js';

async function accountPasswordMatches({
  drizzle,
  auth,
  userId,
  password,
}: {
  drizzle: DrizzleService;
  auth: Auth;
  userId: User['id'];
  password: string;
}): Promise<boolean> {
  const [credential] = await drizzle.db
    .select({ password: account.password })
    .from(account)
    .where(and(eq(account.userId, userId), isNotNull(account.password)))
    .limit(1);
  if (!credential?.password) {
    return false;
  }
  const authContext = await auth.$context;
  return authContext.password.verify({ password, hash: credential.password });
}

/**
 * Checks the account's standing password without touching any other state, so a caller
 * holding a credential that is spent by being checked (a backup code) can reject a wrong
 * password before burning it.
 */
export async function assertAccountPassword(input: {
  drizzle: DrizzleService;
  auth: Auth;
  userId: User['id'];
  password: string;
}): Promise<void> {
  if (!(await accountPasswordMatches(input))) {
    throw new ORPCError('UNAUTHORIZED', { message: 'Current password is invalid.' });
  }
}

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
  await assertAccountPassword({ drizzle, auth, userId, password: currentPassword });

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
  const challengeMethod = await resolveChallengeMethod(drizzle, userId);
  const verification = await verifyChallengeCode(
    api,
    challengeMethod,
    { code: totpCode, trustDevice: false },
    headers,
  );
  if (!verification.ok) {
    await twoFactorLockout?.recordFailure(userId, challengeMethod, meta);
    throw new ORPCError('UNAUTHORIZED', { message: 'Invalid second-factor code.' });
  }
  await twoFactorLockout?.reset(userId);
}

export type FreshReauthenticationServiceDeps = {
  drizzle: DrizzleService;
  auth: Auth;
  twoFactorLockout: TwoFactorLockoutService;
};

/**
 * The `FRESH_REAUTHENTICATION` port: the same proof as `assertFreshReauthentication`, answered
 * as a verdict for a module that shapes its own refusal. The second-factor lock is read before
 * the password, so a locked account answers `locked` whatever password it is sent.
 */
export class FreshReauthenticationService implements FreshReauthentication {
  private readonly drizzle: DrizzleService;
  private readonly auth: Auth;
  private readonly twoFactorLockout: TwoFactorLockoutService;

  constructor({ drizzle, auth, twoFactorLockout }: FreshReauthenticationServiceDeps) {
    this.drizzle = drizzle;
    this.auth = auth;
    this.twoFactorLockout = twoFactorLockout;
  }

  async assert({
    userId,
    headers,
    currentPassword,
    totpCode,
    meta,
  }: Parameters<FreshReauthentication['assert']>[0]): Promise<FreshReauthenticationVerdict> {
    const [caller] = await this.drizzle.db
      .select({
        twoFactorEnabled: user.twoFactorEnabled,
        lockoutUntil: user.twoFactorLockoutUntil,
      })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    if (!caller) {
      return { status: 'password_invalid' };
    }
    if (caller.lockoutUntil && isActiveLockout(caller.lockoutUntil)) {
      return { status: 'locked', lockedUntil: caller.lockoutUntil };
    }
    const passwordMatches = await accountPasswordMatches({
      drizzle: this.drizzle,
      auth: this.auth,
      userId,
      password: currentPassword,
    });
    if (!passwordMatches) {
      return { status: 'password_invalid' };
    }
    if (!caller.twoFactorEnabled) {
      return { status: 'ok' };
    }
    if (!totpCode) {
      return { status: 'second_factor_required' };
    }

    const challengeMethod = await resolveChallengeMethod(this.drizzle, userId);
    const verification = await verifyChallengeCode(
      this.auth.api as unknown as TwoFactorVerifyApi,
      challengeMethod,
      { code: totpCode, trustDevice: false },
      nodeHeadersToHeaders(headers),
    );
    if (!verification.ok) {
      const { attemptsRemaining, lockoutUntil } = await this.twoFactorLockout.countFailure(
        userId,
        challengeMethod,
        meta,
      );
      if (lockoutUntil) {
        return { status: 'locked', lockedUntil: lockoutUntil };
      }
      return attemptsRemaining === undefined
        ? { status: 'second_factor_invalid' }
        : { status: 'second_factor_invalid', attemptsLeft: attemptsRemaining };
    }
    await this.twoFactorLockout.reset(userId);
    return { status: 'ok' };
  }
}

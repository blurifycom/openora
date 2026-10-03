import { eq } from 'drizzle-orm';
import type { DrizzleService } from '@openora/core/server';
import {
  normalizeBackupCode,
  type TwoFactorChallengeMethod,
  type User,
} from '@openora/core/contracts';
import { user } from '../schema/index.js';

/**
 * Library boundary: the base Auth API type omits the endpoints contributed by the
 * twoFactor plugin, but createAuth always installs that plugin for identity.
 */
export type TwoFactorVerifyApi = {
  verifyTOTP(opts: VerifyOpts): Promise<Response>;
  verifyTwoFactorOTP(opts: VerifyOpts): Promise<Response>;
  verifyBackupCode(opts: VerifyOpts): Promise<Response>;
};

type VerifyOpts = {
  body: { code: string; trustDevice: boolean };
  headers: Headers;
  asResponse: true;
};

/**
 * Which endpoint can spend this account's challenge answer. All three delivery
 * methods share one enrolment, so this is purely about the credential the caller
 * presents: an account on `email`/`sms` has no authenticator to read a TOTP off, so
 * verifying one against the shared secret would reject every code it was actually
 * sent - and, on the step-up paths, bank a lockout failure for it.
 *
 * An enrolment that predates the `two_factor_method` column reads as null, and every
 * one of those was an authenticator.
 */
export async function resolveChallengeMethod(
  drizzle: DrizzleService,
  userId: User['id'],
): Promise<Extract<TwoFactorChallengeMethod, 'otp' | 'totp'>> {
  const [row] = await drizzle.db
    .select({ twoFactorMethod: user.twoFactorMethod })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return row?.twoFactorMethod === 'email' || row?.twoFactorMethod === 'sms' ? 'otp' : 'totp';
}

export function verifyChallengeCode(
  api: TwoFactorVerifyApi,
  method: TwoFactorChallengeMethod,
  body: { code: string; trustDevice: boolean },
  headers: Headers,
): Promise<Response> {
  if (method === 'backup_code') {
    return api.verifyBackupCode({
      body: { ...body, code: normalizeBackupCode(body.code) },
      headers,
      asResponse: true,
    });
  }
  if (method === 'otp') {
    return api.verifyTwoFactorOTP({ body, headers, asResponse: true });
  }
  return api.verifyTOTP({ body, headers, asResponse: true });
}

/**
 * better-auth answers 409 when two requests spend the same backup code at once and the
 * other one won. That is a race the caller lost, not a wrong code, so it must not cost a
 * lockout strike.
 */
export function isLostBackupCodeRace(res: Response): boolean {
  return res.status === 409;
}

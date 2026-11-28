import { eq } from 'drizzle-orm';
import type { DrizzleService } from '@openora/core/server';
import {
  normalizeBackupCode,
  type TwoFactorChallengeMethod,
  type User,
} from '@openora/core/contracts';
import { user } from '../schema/index.js';

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

export function isLostBackupCodeRace(res: Response): boolean {
  return res.status === 409;
}

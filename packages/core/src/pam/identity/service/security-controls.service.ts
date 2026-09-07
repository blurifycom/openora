import type { DrizzleService } from '@openora/core/server';
import { E164PhoneSchema, type SecurityControls, type User } from '@openora/core/contracts';
import { eq } from 'drizzle-orm';
import { user } from '../schema/index.js';

export async function getSecurityControls(
  drizzle: DrizzleService,
  userId: User['id'],
): Promise<SecurityControls | null> {
  const [row] = await drizzle.db
    .select({
      passwordMeetsPolicy: user.passwordMeetsPolicy,
      emailVerified: user.emailVerified,
      phoneNumber: user.phoneNumber,
      phoneVerified: user.phoneVerified,
      twoFactorEnabled: user.twoFactorEnabled,
      loginWithdrawalAlertsEnabled: user.loginWithdrawalAlertsEnabled,
    })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  if (!row) {
    return null;
  }
  const phone = E164PhoneSchema.safeParse(row.phoneNumber);
  return {
    ...row,
    phoneNumber: phone.success ? phone.data : null,
    phoneVerified: phone.success && row.phoneVerified,
    twoFactorEnabled: row.twoFactorEnabled ?? false,
  };
}

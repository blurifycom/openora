import { type DrizzleService } from '@openora/core/server';
import type { TwoFactorSetupPolicy, User } from '@openora/core/contracts';
import { eq } from 'drizzle-orm';
import { user } from '../schema/index.js';

export class TwoFactorSetupPolicyService implements TwoFactorSetupPolicy {
  constructor(private readonly drizzle: DrizzleService) {}

  async isSetupRequired(userId: User['id']): Promise<boolean> {
    const [row] = await this.drizzle.db
      .select({
        requireTwoFactorOnLogin: user.requireTwoFactorOnLogin,
        twoFactorEnabled: user.twoFactorEnabled,
      })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    return Boolean(row?.requireTwoFactorOnLogin && !row.twoFactorEnabled);
  }
}

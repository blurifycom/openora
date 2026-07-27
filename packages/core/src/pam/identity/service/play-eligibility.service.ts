import { DrizzleService } from '@openora/core/server';
import { eq } from 'drizzle-orm';
import type { PlayEligibilityPort, User } from '@openora/core/contracts';
import { user } from '../schema/index.js';
import { isRgBlocked } from './rg-guard.service.js';

export class PlayEligibilityService implements PlayEligibilityPort {
  constructor(private readonly drizzle: DrizzleService) {}

  async isRestricted(userId: User['id']): Promise<boolean> {
    const [row] = await this.drizzle.db
      .select({ rgBlocked: user.rgBlocked, rgBlockedUntil: user.rgBlockedUntil })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    if (!row) {
      return true;
    }
    return isRgBlocked(row);
  }
}

import { DrizzleService } from '@openora/core/server';
import { eq } from 'drizzle-orm';
import type { PlayEligibilityPort, User } from '@openora/core/contracts';
import { user } from '../schema/index.js';
import { isRgBlocked } from './rg-guard.service.js';

// Identity-owned reader for the PLAY_ELIGIBILITY port, sharing the `isRgBlocked`
// predicate with the login gate so a wager and a login can never disagree about
// whether a player is restricted. An unknown user is treated as restricted: the
// gate fails closed rather than letting an unresolvable caller wager.
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

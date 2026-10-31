import { DrizzleService, type DrizzleDb } from '@openora/core/server';
import { eq } from 'drizzle-orm';
import type { PlayEligibilityPort, PlayRefusal, User } from '@openora/core/contracts';
import { player } from '@openora/core/pam/schema/profile';
import { user } from '../schema/index.js';
import { isRgBlocked } from './rg-guard.service.js';

export class PlayEligibilityService implements PlayEligibilityPort {
  constructor(private readonly drizzle: DrizzleService) {}

  async isRestricted(userId: User['id'], tx?: unknown): Promise<boolean> {
    const db = (tx as DrizzleDb | undefined) ?? this.drizzle.db;
    const query = db
      .select({ rgBlocked: user.rgBlocked, rgBlockedUntil: user.rgBlockedUntil })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    const [row] = tx ? await query.for('share') : await query;
    if (!row) {
      return true;
    }
    return isRgBlocked(row);
  }

  async checkPlay(userId: User['id'], tx?: unknown): Promise<PlayRefusal | null> {
    const db = (tx as DrizzleDb | undefined) ?? this.drizzle.db;
    const accountQuery = db
      .select({
        rgBlocked: user.rgBlocked,
        rgBlockedUntil: user.rgBlockedUntil,
        isActive: user.isActive,
        banned: user.banned,
        banExpires: user.banExpires,
      })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    const [account] = tx ? await accountQuery.for('share') : await accountQuery;
    if (!account) {
      return 'account_inactive';
    }
    if (isRgBlocked(account)) {
      return account.rgBlockedUntil === null ? 'self_excluded' : 'cooling_off';
    }
    const profileQuery = db
      .select({ status: player.status })
      .from(player)
      .where(eq(player.userId, userId))
      .limit(1);
    const [profile] = tx ? await profileQuery.for('share') : await profileQuery;
    switch (profile?.status) {
      case 'self_excluded':
        return 'self_excluded';
      case 'suspended':
        return 'account_suspended';
      case 'closed':
        return 'account_closed';
    }
    const banned =
      account.banned === true && (account.banExpires === null || account.banExpires > new Date());
    return !account.isActive || banned ? 'account_inactive' : null;
  }
}

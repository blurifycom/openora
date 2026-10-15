import { DrizzleService, type DrizzleDb } from '@openora/core/server';
import { eq } from 'drizzle-orm';
import type { PlayEligibilityPort, User } from '@openora/core/contracts';
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
}

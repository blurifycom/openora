import { type DrizzleService } from '@openora/core/server';
import { gamification } from '../schema/index.js';

export class GamificationService {
  constructor(private readonly drizzle: DrizzleService) {}

  async list() {
    const rows = await this.drizzle.db
      .select({ id: gamification.id, createdAt: gamification.createdAt })
      .from(gamification);
    return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
  }
}

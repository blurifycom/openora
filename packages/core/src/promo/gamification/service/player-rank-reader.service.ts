import { asc, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { PlayerRankReader, Uuid } from '@openora/core/contracts';
import type { DrizzleService } from '@openora/core/server';
import { promoPlayerRank, promoRankTier } from '../schema/index.js';

const lowestTier = alias(promoRankTier, 'lowest_tier');

export class PlayerRankReaderService implements PlayerRankReader {
  constructor(private readonly drizzle: DrizzleService) {}

  async getRankName(userId: Uuid): Promise<string | null> {
    const db = this.drizzle.db;
    const lowest = db
      .select({ name: lowestTier.name })
      .from(lowestTier)
      .orderBy(asc(lowestTier.position))
      .limit(1);
    const [held] = await db
      .select({ name: promoRankTier.name })
      .from(promoPlayerRank)
      .innerJoin(promoRankTier, eq(promoRankTier.id, promoPlayerRank.tierId))
      .where(eq(promoPlayerRank.userId, userId))
      .limit(1);
    if (held) {
      return held.name;
    }
    const [bottom] = await lowest;
    return bottom?.name ?? null;
  }
}

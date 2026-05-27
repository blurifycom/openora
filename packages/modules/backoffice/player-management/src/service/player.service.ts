import { createDomainError } from '@oss/core';
import { DrizzleService } from '@oss/db';
import { eq, ilike, count, or, and, gte, asc, desc } from 'drizzle-orm';
import { player } from '../schema/index.js';
import { user } from '@oss/modules/platform/identity/schema';
import type {
  Player,
  PlayerRegistrationPoint,
  PlayerSummary,
  PlayerStatus,
  KycStatus,
} from '../schemas/index.js';

export const PlayerNotFoundError = createDomainError(
  'PlayerNotFoundError',
  (playerId: string) => `Player not found: ${playerId}`,
);

function toPlayer(p: typeof player.$inferSelect, email: string): Player {
  return {
    id: p.id,
    userId: p.userId,
    displayName: p.displayName,
    email,
    country: p.country,
    currency: p.currency,
    language: p.language,
    status: p.status as PlayerStatus,
    kycStatus: p.kycStatus as KycStatus,
    level: p.level,
    totalWagered: Number(p.totalWagered),
    totalDeposits: Number(p.totalDeposits),
    lastSeenAt: p.lastSeenAt ? p.lastSeenAt.toISOString() : null,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

function toDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export class PlayerService {
  constructor(private readonly drizzle: DrizzleService) {}

  private async emailFor(userId: string): Promise<string> {
    const [record] = await this.drizzle.db
      .select({ email: user.email })
      .from(user)
      .where(eq(user.id, userId));
    return record?.email ?? '';
  }

  async list(
    page: number,
    limit: number,
    search?: string,
    status?: PlayerStatus,
  ): Promise<{ players: Player[]; total: number }> {
    const db = this.drizzle.db;
    const conditions = [];
    if (status) conditions.push(eq(player.status, status));
    if (search) {
      conditions.push(
        or(ilike(player.displayName, `%${search}%`), ilike(player.userId, `%${search}%`))!,
      );
    }
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const [records, [{ n }]] = await Promise.all([
      db
        .select()
        .from(player)
        .where(whereClause)
        .orderBy(desc(player.createdAt))
        .limit(limit)
        .offset((page - 1) * limit),
      db.select({ n: count() }).from(player).where(whereClause),
    ]);
    const players = await Promise.all(
      records.map(async (r) => toPlayer(r, await this.emailFor(r.userId))),
    );
    return { players, total: Number(n) };
  }

  async get(playerId: string): Promise<Player> {
    const [record] = await this.drizzle.db
      .select()
      .from(player)
      .where(eq(player.id, playerId));
    if (!record) throw new PlayerNotFoundError(playerId);
    return toPlayer(record, await this.emailFor(record.userId));
  }

  async update(
    playerId: string,
    data: {
      displayName?: string;
      status?: PlayerStatus;
      kycStatus?: KycStatus;
      level?: number;
    },
  ): Promise<Player> {
    const [existing] = await this.drizzle.db
      .select()
      .from(player)
      .where(eq(player.id, playerId));
    if (!existing) throw new PlayerNotFoundError(playerId);
    const patch: Partial<typeof player.$inferInsert> = {};
    if (data.displayName !== undefined) patch.displayName = data.displayName;
    if (data.status !== undefined) patch.status = data.status;
    if (data.kycStatus !== undefined) patch.kycStatus = data.kycStatus;
    if (data.level !== undefined) patch.level = data.level;
    const [record] = await this.drizzle.db
      .update(player)
      .set(patch)
      .where(eq(player.id, playerId))
      .returning();
    return toPlayer(record!, await this.emailFor(record!.userId));
  }

  async remove(playerId: string): Promise<{ success: boolean }> {
    const [existing] = await this.drizzle.db
      .select()
      .from(player)
      .where(eq(player.id, playerId));
    if (!existing) throw new PlayerNotFoundError(playerId);
    await this.drizzle.db.delete(player).where(eq(player.id, playerId));
    return { success: true };
  }

  async registrationsOverTime(days = 30): Promise<PlayerRegistrationPoint[]> {
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    since.setUTCDate(since.getUTCDate() - (days - 1));
    const records = await this.drizzle.db
      .select()
      .from(player)
      .where(gte(player.createdAt, since))
      .orderBy(asc(player.createdAt));
    const buckets = new Map<string, number>();
    for (let i = 0; i < days; i++) {
      const d = new Date(since);
      d.setUTCDate(since.getUTCDate() + i);
      buckets.set(toDateKey(d), 0);
    }
    for (const r of records) {
      const key = toDateKey(r.createdAt);
      if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
    return [...buckets.entries()].map(([date, count]) => ({ date, count }));
  }

  async summary(): Promise<PlayerSummary> {
    const weekAgo = new Date();
    weekAgo.setUTCDate(weekAgo.getUTCDate() - 7);
    const db = this.drizzle.db;
    const [total, active, newLastWeek, selfExcluded] = await Promise.all([
      db.select({ n: count() }).from(player).then(([r]) => Number(r?.n ?? 0)),
      db
        .select({ n: count() })
        .from(player)
        .where(eq(player.status, 'active'))
        .then(([r]) => Number(r?.n ?? 0)),
      db
        .select({ n: count() })
        .from(player)
        .where(gte(player.createdAt, weekAgo))
        .then(([r]) => Number(r?.n ?? 0)),
      db
        .select({ n: count() })
        .from(player)
        .where(eq(player.status, 'self_excluded'))
        .then(([r]) => Number(r?.n ?? 0)),
    ]);
    return { total, active, newLastWeek, selfExcluded };
  }
}

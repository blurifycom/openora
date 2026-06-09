import { makeNotFoundError } from '@oss/core';
import { DrizzleService, findOneOrThrow, pageToOffset } from '@oss/db';
import { eq, ilike, count, or, and, gte, desc, sql } from 'drizzle-orm';
import { player } from '../schema/index.js';
import { user } from '@oss/modules/platform/identity/schema';
import type { UpdatePlayerProfileInput } from '@oss/orpc-contract';
import type {
  Player,
  PlayerRegistrationPoint,
  PlayerSummary,
  PlayerStatus,
  KycStatus,
} from '../schemas/index.js';

export const PlayerNotFoundError = makeNotFoundError('Player');

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

  // --- Player-facing self profile (resolved from x-user-id, not admin) ---

  // Return the caller's player row, creating a default one on first access.
  // Registration only creates the auth `user`; the `player` profile row is
  // materialised lazily here so a freshly-registered user always has a profile.
  private async ensureProfile(userId: string): Promise<Player> {
    const [existing] = await this.drizzle.db.select().from(player).where(eq(player.userId, userId));
    if (existing) return toPlayer(existing, await this.emailFor(userId));

    const [u] = await this.drizzle.db
      .select({ name: user.name, email: user.email })
      .from(user)
      .where(eq(user.id, userId));
    const [created] = await this.drizzle.db
      .insert(player)
      .values({ userId, displayName: u?.name ?? 'Player' })
      .returning();
    return toPlayer(created!, u?.email ?? '');
  }

  async getMyProfile(userId: string): Promise<Player> {
    return this.ensureProfile(userId);
  }

  async updateMyProfile(userId: string, data: UpdatePlayerProfileInput): Promise<Player> {
    await this.ensureProfile(userId);
    const patch: Partial<typeof player.$inferInsert> = {};
    if (data.displayName !== undefined) patch.displayName = data.displayName;
    if (data.country !== undefined) patch.country = data.country;
    if (data.currency !== undefined) patch.currency = data.currency;
    if (data.language !== undefined) patch.language = data.language;
    const [record] = await this.drizzle.db
      .update(player)
      .set(patch)
      .where(eq(player.userId, userId))
      .returning();
    return toPlayer(record!, await this.emailFor(userId));
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
    // Page rows joined to their email in ONE query (LEFT JOIN, many players ->
    // one user, so the limit is not multiplied), plus a single COUNT for total.
    const [rows, [{ n }]] = await Promise.all([
      db
        .select({ player, email: user.email })
        .from(player)
        .leftJoin(user, eq(user.id, player.userId))
        .where(whereClause)
        .orderBy(desc(player.createdAt))
        .limit(limit)
        .offset(pageToOffset(page, limit)),
      db.select({ n: count() }).from(player).where(whereClause),
    ]);
    const players = rows.map((r) => toPlayer(r.player, r.email ?? ''));
    return { players, total: Number(n) };
  }

  async get(playerId: string): Promise<Player> {
    const record = findOneOrThrow(
      await this.drizzle.db.select().from(player).where(eq(player.id, playerId)),
      new PlayerNotFoundError(playerId),
    );
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
    findOneOrThrow(
      await this.drizzle.db.select().from(player).where(eq(player.id, playerId)),
      new PlayerNotFoundError(playerId),
    );
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
    findOneOrThrow(
      await this.drizzle.db.select().from(player).where(eq(player.id, playerId)),
      new PlayerNotFoundError(playerId),
    );
    await this.drizzle.db.delete(player).where(eq(player.id, playerId));
    return { success: true };
  }

  async registrationsOverTime(days = 30): Promise<PlayerRegistrationPoint[]> {
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    since.setUTCDate(since.getUTCDate() - (days - 1));
    // Aggregate at the DB (GROUP BY day) - returns at most `days` rows, never
    // the full player set. The day key matches toDateKey (UTC YYYY-MM-DD).
    const dayKey = sql<string>`to_char(date_trunc('day', ${player.createdAt}), 'YYYY-MM-DD')`;
    const rows = await this.drizzle.db
      .select({ date: dayKey, n: count() })
      .from(player)
      .where(gte(player.createdAt, since))
      .groupBy(dayKey);
    const countByDay = new Map(rows.map((r) => [r.date, Number(r.n)]));
    // Fill the contiguous day series (bounded by `days`, not by row count).
    return Array.from({ length: days }, (_, i) => {
      const d = new Date(since);
      d.setUTCDate(since.getUTCDate() + i);
      const date = toDateKey(d);
      return { date, count: countByDay.get(date) ?? 0 };
    });
  }

  async summary(): Promise<PlayerSummary> {
    const weekAgo = new Date();
    weekAgo.setUTCDate(weekAgo.getUTCDate() - 7);
    const db = this.drizzle.db;
    const [total, active, newLastWeek, selfExcluded] = await Promise.all([
      db
        .select({ n: count() })
        .from(player)
        .then(([r]) => Number(r?.n ?? 0)),
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

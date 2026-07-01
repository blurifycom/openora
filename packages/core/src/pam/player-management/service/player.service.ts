import {
  makeNotFoundError,
  makeConflictError,
  type EventBus,
  DrizzleService,
  findOneOrThrow,
  pageToOffset,
} from '@blurifycom/core/server';
import { eq, ilike, count, or, and, gte, desc, sql, ne } from 'drizzle-orm';
import { player } from '../../profile/schema/index.js';
import { user } from '../../identity/schema/index.js';
import type { PlayerStatus, KycStatus } from '../schemas/index.js';
import { toPlayer, fetchEmail } from '../../shared/player-mapper.js';

export const PlayerNotFoundError = makeNotFoundError('Player');
export const DuplicateEmailError = makeConflictError('DuplicateEmail', 'Email is already in use');

function toDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export class PlayerService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
  ) {}

  async list(page: number, limit: number, search?: string, status?: PlayerStatus) {
    const db = this.drizzle.db;
    const conditions = [];
    if (status) conditions.push(eq(player.status, status));
    if (search) {
      conditions.push(
        or(
          ilike(player.displayName, `%${search}%`),
          ilike(sql`${player.userId}::text`, search),
          ilike(user.email, `%${search}%`),
        )!,
      );
    }
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const [rows, [{ n }]] = await Promise.all([
      db
        .select({ player, email: user.email })
        .from(player)
        .leftJoin(user, eq(user.id, player.userId))
        .where(whereClause)
        .orderBy(desc(player.createdAt))
        .limit(limit)
        .offset(pageToOffset(page, limit)),
      db
        .select({ n: count() })
        .from(player)
        .leftJoin(user, eq(user.id, player.userId))
        .where(whereClause),
    ]);
    const items = rows.map((r) => toPlayer(r.player, r.email ?? ''));
    return { items, total: Number(n), page, limit };
  }

  async get(playerId: string) {
    const record = findOneOrThrow(
      await this.drizzle.db.select().from(player).where(eq(player.id, playerId)),
      new PlayerNotFoundError(playerId),
    );
    return toPlayer(record, await fetchEmail(this.drizzle, record.userId));
  }

  async getExtended(playerId: string) {
    const record = findOneOrThrow(
      await this.drizzle.db.select().from(player).where(eq(player.id, playerId)),
      new PlayerNotFoundError(playerId),
    );
    return toPlayer(record, await fetchEmail(this.drizzle, record.userId));
  }

  async update(
    playerId: string,
    data: {
      displayName?: string;
      status?: PlayerStatus;
      kycStatus?: KycStatus;
      level?: number;
      email?: string;
    },
    actorId: string,
  ) {
    const existing = findOneOrThrow(
      await this.drizzle.db.select().from(player).where(eq(player.id, playerId)),
      new PlayerNotFoundError(playerId),
    );

    if (data.email !== undefined) {
      const clash = await this.drizzle.db
        .select({ id: user.id })
        .from(user)
        .where(and(eq(user.email, data.email), ne(user.id, existing.userId)))
        .limit(1);
      if (clash.length > 0) throw new DuplicateEmailError();
    }

    const patch: Partial<typeof player.$inferInsert> = {};
    if (data.displayName !== undefined) patch.displayName = data.displayName;
    if (data.status !== undefined) patch.status = data.status;
    if (data.kycStatus !== undefined) patch.kycStatus = data.kycStatus;
    if (data.level !== undefined) patch.level = data.level;

    const record = await this.drizzle.db.transaction(async (trx) => {
      if (data.email !== undefined) {
        await trx.update(user).set({ email: data.email }).where(eq(user.id, existing.userId));
      }
      const rows = await trx.update(player).set(patch).where(eq(player.id, playerId)).returning();
      return findOneOrThrow(rows, new PlayerNotFoundError(playerId));
    });

    // Audit KYC transitions (regulatory). Emit AFTER commit, only on a real change.
    if (data.kycStatus !== undefined && data.kycStatus !== existing.kycStatus) {
      this.events.emit('compliance.kyc.updated', {
        userId: existing.userId,
        actorId,
        status: data.kycStatus,
        previousStatus: existing.kycStatus,
      });
    }
    return toPlayer(record, await fetchEmail(this.drizzle, record.userId));
  }

  async remove(playerId: string) {
    findOneOrThrow(
      await this.drizzle.db.select().from(player).where(eq(player.id, playerId)),
      new PlayerNotFoundError(playerId),
    );
    await this.drizzle.db.delete(player).where(eq(player.id, playerId));
    return { success: true };
  }

  async registrationsOverTime(days = 30) {
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    since.setUTCDate(since.getUTCDate() - (days - 1));
    const dayKey = sql<string>`to_char(date_trunc('day', ${player.createdAt}), 'YYYY-MM-DD')`;
    const rows = await this.drizzle.db
      .select({ date: dayKey, n: count() })
      .from(player)
      .where(gte(player.createdAt, since))
      .groupBy(dayKey);
    const countByDay = new Map(rows.map((r) => [r.date, Number(r.n)]));
    return Array.from({ length: days }, (_, i) => {
      const d = new Date(since);
      d.setUTCDate(since.getUTCDate() + i);
      const date = toDateKey(d);
      return { date, count: countByDay.get(date) ?? 0 };
    });
  }

  async summary() {
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

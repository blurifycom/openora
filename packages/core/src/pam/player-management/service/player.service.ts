import {
  makeNotFoundError,
  makeConflictError,
  DrizzleService,
  findOneOrThrow,
  pageToOffset,
} from '@openora/core/server';
import type {
  KycStatusWriter,
  PlayerStatus,
  KycStatus,
  Player,
  User,
  TagKey,
} from '@openora/core/contracts';
import { eq, ilike, count, or, and, gte, desc, sql, ne, inArray, isNull } from 'drizzle-orm';
import { player } from '@openora/core/pam/schema/profile';
import { user } from '@openora/core/pam/schema/identity';
import { playerTag, tag } from '@openora/core/pam/schema/tag';
import { toPlayer, fetchEmailByUserId } from '../../shared/player-mapper.js';

export const PlayerNotFoundError = makeNotFoundError('Player');
export const DuplicateEmailError = makeConflictError('DuplicateEmail', 'Email is already in use');

function toDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export class PlayerService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly kycStatusWriter: KycStatusWriter,
  ) {}

  async list({
    page,
    limit,
    search,
    status,
    kycStatus,
    tags,
  }: {
    page: number;
    limit: number;
    search?: string;
    status?: PlayerStatus;
    kycStatus?: KycStatus;
    tags?: TagKey[];
  }) {
    const db = this.drizzle.db;
    const conditions = [];
    if (status) {
      conditions.push(eq(player.status, status));
    }
    if (kycStatus) {
      conditions.push(eq(player.kycStatus, kycStatus));
    }
    if (search) {
      conditions.push(
        or(
          ilike(player.displayName, `%${search}%`),
          ilike(sql`${player.userId}::text`, search),
          ilike(sql`${player.id}::text`, search),
          ilike(user.email, `%${search}%`),
        ),
      );
    }
    if (tags && tags.length > 0) {
      conditions.push(
        inArray(
          player.id,
          db
            .select({ id: playerTag.playerId })
            .from(playerTag)
            .innerJoin(tag, eq(playerTag.tagId, tag.id))
            .where(and(inArray(tag.key, tags), isNull(playerTag.removedAt))),
        ),
      );
    }
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const [rows, [{ n }]] = await Promise.all([
      db
        .select({
          player,
          email: user.email,
          // Cast to text[] so pg driver deserializes as string[] (no parser for enum arrays).
          tags: sql<
            string[]
          >`coalesce(array_agg(${tag.key}::text) filter (where ${tag.key} is not null), '{}'::text[])`,
        })
        .from(player)
        .leftJoin(user, eq(user.id, player.userId))
        .leftJoin(playerTag, and(eq(playerTag.playerId, player.id), isNull(playerTag.removedAt)))
        .leftJoin(tag, eq(tag.id, playerTag.tagId))
        .groupBy(player.id, user.email)
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
    const items = rows.map((r) => ({
      ...toPlayer(r.player, r.email ?? ''),
      tags: r.tags as TagKey[],
    }));
    return { items, total: Number(n), page, limit };
  }

  private async fetchOneWithTags(playerId: Player['id']) {
    const db = this.drizzle.db;
    const row = findOneOrThrow(
      await db
        .select({
          player,
          email: user.email,
          // Cast to text[] so pg driver deserializes as string[] (no parser for enum arrays).
          tags: sql<
            string[]
          >`coalesce(array_agg(${tag.key}::text) filter (where ${tag.key} is not null), '{}'::text[])`,
        })
        .from(player)
        .leftJoin(user, eq(user.id, player.userId))
        .leftJoin(playerTag, and(eq(playerTag.playerId, player.id), isNull(playerTag.removedAt)))
        .leftJoin(tag, eq(tag.id, playerTag.tagId))
        .groupBy(player.id, user.email)
        .where(eq(player.id, playerId)),
      new PlayerNotFoundError(playerId),
    );
    return { ...toPlayer(row.player, row.email ?? ''), tags: row.tags as TagKey[] };
  }

  async get(playerId: Player['id']) {
    return this.fetchOneWithTags(playerId);
  }

  async getByUserId(userId: User['id']) {
    const record = findOneOrThrow(
      await this.drizzle.db.select().from(player).where(eq(player.userId, userId)),
      new PlayerNotFoundError(userId),
    );
    return toPlayer(record, await fetchEmailByUserId(this.drizzle, record.userId));
  }

  async getExtended(playerId: Player['id']) {
    return this.fetchOneWithTags(playerId);
  }

  async update(
    playerId: Player['id'],
    data: Partial<Pick<Player, 'displayName' | 'status' | 'kycStatus' | 'level' | 'email'>>,
    actorId: User['id'],
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
      if (clash.length > 0) {
        throw new DuplicateEmailError();
      }
    }

    const patch: Partial<typeof player.$inferInsert> = {};
    if (data.displayName !== undefined) {
      patch.displayName = data.displayName;
    }
    if (data.status !== undefined) {
      patch.status = data.status;
    }
    if (data.level !== undefined) {
      patch.level = data.level;
    }

    // One transaction so the email/field patch + the KYC write commit or roll back together.
    await this.drizzle.db.transaction(async (trx) => {
      if (data.email !== undefined) {
        await trx.update(user).set({ email: data.email }).where(eq(user.id, existing.userId));
      }
      if (Object.keys(patch).length > 0) {
        await trx.update(player).set(patch).where(eq(player.id, playerId));
      }
      // A KYC transition is a regulated single-writer action - route it through the
      // KYC_STATUS_WRITER seam (it owns the player.kycStatus write + compliance.kyc.updated
      // emit), so an admin override and a vendor decision share one code path. Runs on this
      // txn via its optional tx handle.
      if (data.kycStatus !== undefined && data.kycStatus !== existing.kycStatus) {
        await this.kycStatusWriter.setStatus(
          existing.userId,
          data.kycStatus,
          { actorId, source: 'manual' },
          trx,
        );
      }
      // Verify the row still exists after all writes before the txn commits.
      findOneOrThrow(
        await trx.select().from(player).where(eq(player.id, playerId)),
        new PlayerNotFoundError(playerId),
      );
    });

    return this.fetchOneWithTags(playerId);
  }

  async remove(playerId: Player['id']) {
    findOneOrThrow(
      await this.drizzle.db.select().from(player).where(eq(player.id, playerId)),
      new PlayerNotFoundError(playerId),
    );
    await this.drizzle.db.update(player).set({ status: 'closed' }).where(eq(player.id, playerId));
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

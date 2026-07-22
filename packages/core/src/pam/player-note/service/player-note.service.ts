import { DrizzleService, pageToOffset, serializeRow } from '@openora/core/server';
import { asc, count, desc, eq } from 'drizzle-orm';
import type { Player, User, SortOrder } from '@openora/core/contracts';
import { playerNote } from '../schema/index.js';
import type { CreatePlayerNoteInput, PlayerNoteItem, PlayerNoteSortBy } from '../contract/index.js';

const DATE_FIELDS = ['createdAt', 'updatedAt'] as const;

function toItem(row: typeof playerNote.$inferSelect): PlayerNoteItem {
  return serializeRow(row, { dateFields: DATE_FIELDS });
}

export class PlayerNoteService {
  constructor(private readonly drizzle: DrizzleService) {}

  async list({
    playerId,
    page,
    limit,
    sortBy,
    sortOrder,
  }: {
    playerId: Player['id'];
    page: number;
    limit: number;
    sortBy?: PlayerNoteSortBy;
    sortOrder?: SortOrder;
  }) {
    const where = eq(playerNote.playerId, playerId);
    const db = this.drizzle.db;
    const dir = (sortOrder ?? 'desc') === 'asc' ? asc : desc;
    const col = sortBy === 'updatedAt' ? playerNote.updatedAt : playerNote.createdAt;
    const [rows, [{ n }]] = await Promise.all([
      db
        .select()
        .from(playerNote)
        .where(where)
        .orderBy(dir(col))
        .limit(limit)
        .offset(pageToOffset(page, limit)),
      db.select({ n: count() }).from(playerNote).where(where),
    ]);
    return { items: rows.map(toItem), total: Number(n), page, limit };
  }

  async create(input: CreatePlayerNoteInput, actorId: User['id']) {
    const [created] = await this.drizzle.db
      .insert(playerNote)
      .values({ ...input, actorId })
      .returning();
    return toItem(created);
  }
}

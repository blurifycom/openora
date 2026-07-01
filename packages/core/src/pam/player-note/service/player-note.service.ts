import { DrizzleService, pageToOffset, serializeRow } from '@blurifycom/core/server';
import { count, desc, eq } from 'drizzle-orm';
import { playerNote } from '../schema/index.js';
import type { CreatePlayerNoteInput, PlayerNoteItem } from '../contract/index.js';

const DATE_FIELDS = ['createdAt', 'updatedAt'] as const;

function toItem(row: typeof playerNote.$inferSelect): PlayerNoteItem {
  return serializeRow(row, { dateFields: DATE_FIELDS });
}

export class PlayerNoteService {
  constructor(private readonly drizzle: DrizzleService) {}

  async list(playerId: string, page: number, limit: number) {
    const where = eq(playerNote.playerId, playerId);
    const db = this.drizzle.db;
    const [rows, [{ n }]] = await Promise.all([
      db
        .select()
        .from(playerNote)
        .where(where)
        .orderBy(desc(playerNote.createdAt))
        .limit(limit)
        .offset(pageToOffset(page, limit)),
      db.select({ n: count() }).from(playerNote).where(where),
    ]);
    return { items: rows.map(toItem), total: Number(n), page, limit };
  }

  async create(input: CreatePlayerNoteInput, actorId: string): Promise<PlayerNoteItem> {
    const [created] = await this.drizzle.db
      .insert(playerNote)
      .values({ playerId: input.playerId, actorId, content: input.content })
      .returning();
    return toItem(created);
  }
}

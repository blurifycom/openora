import { DrizzleService, pageToOffset } from '@blurifycom/core/server';
import { count, desc, eq } from 'drizzle-orm';
import { playerNote } from '../schema/index.js';
import type { CreatePlayerNoteInput, PlayerNoteItem } from '../contract/index.js';

function toIso(d: Date | string): string {
  return d instanceof Date ? d.toISOString() : d;
}

function toItem(row: typeof playerNote.$inferSelect): PlayerNoteItem {
  return {
    id: row.id,
    playerId: row.playerId,
    actorId: row.actorId,
    content: row.content,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
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

import { DrizzleService } from '@blurifycom/core/server';
import { desc, eq } from 'drizzle-orm';
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

  async list(playerId: string): Promise<{ notes: PlayerNoteItem[] }> {
    const rows = await this.drizzle.db
      .select()
      .from(playerNote)
      .where(eq(playerNote.playerId, playerId))
      .orderBy(desc(playerNote.createdAt));
    return { notes: rows.map(toItem) };
  }

  async create(input: CreatePlayerNoteInput, actorId: string): Promise<PlayerNoteItem> {
    const [created] = await this.drizzle.db
      .insert(playerNote)
      .values({ playerId: input.playerId, actorId, content: input.content })
      .returning();
    return toItem(created);
  }
}

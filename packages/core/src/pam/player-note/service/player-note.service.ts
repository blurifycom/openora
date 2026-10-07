import {
  DrizzleService,
  makeNotFoundError,
  pageToOffset,
  serializeRow,
} from '@openora/core/server';
import { asc, count, desc, eq, isNotNull } from 'drizzle-orm';
import type {
  AuditWritePort,
  Player,
  User,
  PaginationOptions,
  Uuid,
} from '@openora/core/contracts';
import { player } from '@openora/core/pam/schema/profile';
import { playerNote } from '../schema/index.js';
import type { CreatePlayerNoteInput, PlayerNoteItem, PlayerNoteSortBy } from '../contract/index.js';

const DATE_FIELDS = ['createdAt', 'updatedAt'] as const;

export const PlayerNotFoundError = makeNotFoundError('Player');

function toItem({
  proposalId: _proposalId,
  ...note
}: typeof playerNote.$inferSelect): PlayerNoteItem {
  return serializeRow(note, { dateFields: DATE_FIELDS });
}

export class PlayerNoteService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly audit: AuditWritePort,
  ) {}

  async list({
    playerId,
    page,
    limit,
    sortBy,
    sortOrder,
  }: PaginationOptions<{ playerId: Player['id'] }, PlayerNoteSortBy>) {
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

  async playerExists(playerId: Player['id']) {
    const [found] = await this.drizzle.db
      .select({ id: player.id })
      .from(player)
      .where(eq(player.id, playerId))
      .limit(1);
    return found !== undefined;
  }

  /**
   * Adds the note an approved agent proposal carries, at most once per proposal. The note keeps
   * the proposal id under a unique index, so a replay of the proposal, or a second execution
   * racing the first, inserts nothing; another proposal with the same text adds its own note.
   */
  async createForProposal({
    playerId,
    content,
    actorId,
    proposalId,
  }: {
    playerId: Player['id'];
    content: string;
    actorId: User['id'];
    proposalId: Uuid;
  }) {
    return this.drizzle.db.transaction(async (tx) => {
      const [target] = await tx
        .select({ id: player.id })
        .from(player)
        .where(eq(player.id, playerId))
        .limit(1);
      if (!target) {
        throw new PlayerNotFoundError(playerId);
      }
      const [created] = await tx
        .insert(playerNote)
        .values({ playerId, actorId, content, proposalId })
        .onConflictDoNothing({
          target: playerNote.proposalId,
          where: isNotNull(playerNote.proposalId),
        })
        .returning();
      if (!created) {
        return { status: 'already_created' as const };
      }
      await this.audit.recordInTransaction(tx, {
        actorId,
        actorType: 'admin',
        action: 'admin.player_note.created',
        resourceType: 'player',
        resourceId: playerId,
        after: { noteId: created.id, content: created.content, proposalId },
      });
      return { status: 'created' as const, note: toItem(created) };
    });
  }
}

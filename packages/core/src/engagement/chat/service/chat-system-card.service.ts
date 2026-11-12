import { eq } from 'drizzle-orm';
import type { DomainEventPayload, RealtimeTransport } from '@openora/core/contracts';
import { GLOBAL_CHAT_ROOM_ID } from '@openora/core/contracts';
import type { DrizzleService } from '@openora/core/server';
import { chatMessage, chatRoom } from '../schema/index.js';
import { publishChatEvent, toWrittenSystemMessage } from './chat.service.js';

export type SystemCardUpsert = DomainEventPayload<'chat.system_message.upserted'>;

type StoredCard = Pick<typeof chatMessage.$inferSelect, 'roomId' | 'userId' | 'type' | 'version'>;

export type SystemCardOutcome = 'inserted' | 'updated' | 'stale' | 'conflict' | 'room-gone';

/**
 * What an upsert does to the message already stored under its id. The id is the caller's own
 * record id, so a row that is not this actor's system card in this room is someone else's
 * message: it is refused, never overwritten. Same card: only a higher version applies.
 */
export function resolveSystemCardWrite(
  stored: StoredCard,
  incoming: Pick<SystemCardUpsert, 'roomId' | 'actorId' | 'version'>,
): 'updated' | 'stale' | 'conflict' {
  if (
    stored.type !== 'system' ||
    stored.roomId !== incoming.roomId ||
    stored.userId !== incoming.actorId
  ) {
    return 'conflict';
  }
  return incoming.version > stored.version ? 'updated' : 'stale';
}

/** Applies `chat.system_message.upserted` to the chat table: idempotent and order-safe. */
export class ChatSystemCardService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly transport: RealtimeTransport,
  ) {}

  /**
   * Publishes the card to realtime clients once it is stored, so a refused, stale or dropped
   * card never reaches them, and a redelivery that changes nothing publishes nothing.
   */
  async apply(card: SystemCardUpsert): Promise<SystemCardOutcome> {
    const { outcome, record } = await this.write(card);
    if (record) {
      publishChatEvent(
        this.transport,
        record.roomId,
        toWrittenSystemMessage(record, card.metadata),
      );
    }
    return outcome;
  }

  private write(
    card: SystemCardUpsert,
  ): Promise<{ outcome: SystemCardOutcome; record?: typeof chatMessage.$inferSelect }> {
    return this.drizzle.db.transaction(async (tx) => {
      let roomId = card.roomId;
      if (roomId !== null) {
        const [room] = await tx
          .select({ slug: chatRoom.slug, deletedAt: chatRoom.deletedAt })
          .from(chatRoom)
          .where(eq(chatRoom.id, roomId))
          .limit(1);
        if (!room || room.deletedAt !== null) {
          return { outcome: 'room-gone' };
        }
        // The global room is stored as a null room id, as the local writer does.
        roomId = room.slug === GLOBAL_CHAT_ROOM_ID ? null : roomId;
      }
      const [inserted] = await tx
        .insert(chatMessage)
        .values({
          id: card.messageId,
          roomId,
          userId: card.actorId,
          username: card.username,
          content: '',
          type: 'system',
          metadata: card.metadata,
          version: card.version,
        })
        .onConflictDoNothing({ target: chatMessage.id })
        .returning();
      if (inserted) {
        return { outcome: 'inserted', record: inserted };
      }
      const [stored] = await tx
        .select({
          roomId: chatMessage.roomId,
          userId: chatMessage.userId,
          type: chatMessage.type,
          version: chatMessage.version,
        })
        .from(chatMessage)
        .where(eq(chatMessage.id, card.messageId))
        .for('update');
      if (!stored) {
        // Deleted between the insert and the read: the next delivery inserts it.
        throw new Error(`chat system card ${card.messageId} vanished mid-upsert`);
      }
      const outcome = resolveSystemCardWrite(stored, { ...card, roomId });
      if (outcome !== 'updated') {
        return { outcome };
      }
      const [updated] = await tx
        .update(chatMessage)
        .set({ metadata: card.metadata, version: card.version })
        .where(eq(chatMessage.id, card.messageId))
        .returning();
      return { outcome, record: updated };
    });
  }
}

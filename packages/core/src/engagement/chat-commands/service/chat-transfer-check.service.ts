import { ORPCError } from '@orpc/server';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { withAdvisoryXactLocks, type DrizzleTx } from '@openora/core/server';
import {
  ChatContextSendDecisionSchema,
  ChatTransferCheckInputSchema,
  GLOBAL_CHAT_ROOM_ID,
  chatBlockLockKey,
  type ChatContextSendPolicy,
  type ChatRoomAccess,
  type ChatTransferCheckInput,
  type ChatTransferRefusal,
  type ChatTransferVerdict,
  type Uuid,
} from '@openora/core/contracts';
import { chatRoom, chatUserBlock } from '@openora/core/engagement/schema/chat';
import { chatCommandConfig } from '../schema/index.js';

const refuse = (refusal: ChatTransferRefusal): ChatTransferVerdict => ({ allowed: false, refusal });

/**
 * Local `CHAT_TRANSFER_CHECK`: every read goes through the caller's transaction, which it
 * requires, so the block lock below cannot be skipped by calling it outside one.
 */
export class ChatTransferCheckService {
  constructor(
    private readonly deps: {
      roomAccess: ChatRoomAccess;
      contextSendPolicy: ChatContextSendPolicy;
    },
  ) {}

  async check(
    transaction: unknown,
    rawInput: ChatTransferCheckInput,
  ): Promise<ChatTransferVerdict> {
    if (!transaction) {
      throw new Error('CHAT_TRANSFER_CHECK needs the caller transaction to hold its block locks');
    }
    const tx = transaction as DrizzleTx;
    const input = ChatTransferCheckInputSchema.parse(rawInput);
    const [command] = await tx
      .select({ enabled: chatCommandConfig.enabled, config: chatCommandConfig.config })
      .from(chatCommandConfig)
      .where(eq(chatCommandConfig.key, input.command))
      .limit(1);
    if (!command?.enabled) {
      return refuse('command_disabled');
    }

    const [room] = await tx
      .select({
        id: chatRoom.id,
        slug: chatRoom.slug,
        kind: chatRoom.kind,
        contextRef: chatRoom.contextRef,
      })
      .from(chatRoom)
      .where(
        and(
          input.roomId === null
            ? eq(chatRoom.slug, GLOBAL_CHAT_ROOM_ID)
            : eq(chatRoom.id, input.roomId),
          isNull(chatRoom.deletedAt),
        ),
      )
      .limit(1);
    if (!room) {
      return refuse('room_not_found');
    }
    const accessRefusal = await this.roomAccessRefusal(tx, room.id, input.actorId);
    if (accessRefusal) {
      return refuse(accessRefusal);
    }
    const contextRef = room.kind === 'context' ? room.contextRef : null;
    if (contextRef !== null) {
      const decision = ChatContextSendDecisionSchema.parse(
        await this.deps.contextSendPolicy.check({
          userId: input.actorId,
          roomId: room.id,
          contextRef,
          tx,
        }),
      );
      if (!decision.allowed) {
        return { allowed: false, refusal: 'context_send_denied', policyReason: decision.reason };
      }
    }

    return {
      allowed: true,
      canonicalRoomId: room.slug === GLOBAL_CHAT_ROOM_ID ? null : room.id,
      contextRef,
      blockedIds: await this.blockedCounterparts(tx, input),
      commandConfig: command.config ?? {},
    };
  }

  // CHAT_ROOM_ACCESS answers with the router's error codes: a missing room, or a non-member or
  // banned actor. Anything else is a fault and propagates, which fails the caller's transaction.
  // Bans and membership take no lock: one lifted or added after this read and before the
  // caller commits is not seen.
  private async roomAccessRefusal(tx: DrizzleTx, roomId: Uuid, actorId: Uuid) {
    try {
      await this.deps.roomAccess.verifyRoomAccess(roomId, actorId, tx);
      return null;
    } catch (error) {
      if (error instanceof ORPCError && error.code === 'NOT_FOUND') {
        return 'room_not_found' as const;
      }
      if (error instanceof ORPCError && error.code === 'FORBIDDEN') {
        return 'room_access_denied' as const;
      }
      throw error;
    }
  }

  // A shared lock per direction makes `blockUser` (which takes the same key exclusively) wait
  // for the money to commit, or the read here wait for the block.
  private async blockedCounterparts(tx: DrizzleTx, input: ChatTransferCheckInput) {
    const { actorId } = input;
    const counterpartIds = [...new Set(input.counterpartIds)].filter((id) => id !== actorId);
    if (counterpartIds.length === 0) {
      return [];
    }
    const rows = await withAdvisoryXactLocks(
      tx,
      counterpartIds.flatMap((id) => [
        chatBlockLockKey(actorId, id),
        chatBlockLockKey(id, actorId),
      ]),
      () =>
        tx
          .select({ blockerId: chatUserBlock.blockerId, blockedId: chatUserBlock.blockedId })
          .from(chatUserBlock)
          .where(
            and(
              isNull(chatUserBlock.removedAt),
              or(
                and(
                  eq(chatUserBlock.blockerId, actorId),
                  inArray(chatUserBlock.blockedId, counterpartIds),
                ),
                and(
                  inArray(chatUserBlock.blockerId, counterpartIds),
                  eq(chatUserBlock.blockedId, actorId),
                ),
              ),
            ),
          ),
      'shared',
    );
    const blocked = new Set(
      rows.map((row) => (row.blockerId === actorId ? row.blockedId : row.blockerId)),
    );
    return counterpartIds.filter((id) => blocked.has(id));
  }
}

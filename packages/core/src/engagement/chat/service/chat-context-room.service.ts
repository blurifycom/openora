import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import {
  createLogger,
  withAdvisoryXactLock,
  type DrizzleService,
  type DrizzleTx,
  type EventBus,
} from '@openora/core/server';
import {
  CHAT_SYSTEM_AUTHOR_ID,
  ChatContextRefSchema,
  chatChannel,
  EnsureChatContextRoomInputSchema,
  SystemEventMetadataSchema,
  type AuditWritePort,
  type ChatContextRoom,
  type ChatContextRooms,
  type ChatContextRoomWrite,
  type ChatSystemWriter,
  type IdentityReader,
  type RealtimeTransport,
  type Uuid,
} from '@openora/core/contracts';
import { user } from '@openora/core/pam/schema/identity';
import { chatRoom, chatRoomConfiguration, chatRoomMember } from '../schema/index.js';
import type { ChatMemberJoinedSignal, ChatRoomClosedSignal } from '../contract/index.js';
import {
  CHAT_MEMBER_JOINED_SIGNAL,
  CHAT_ROOM_CLOSED_SIGNAL,
  CONTEXT_ROOM_SLUG_PREFIX,
  STAFF_USER_ROLES,
} from '../contract/constants.js';
import { ChatContextRoomNotFoundError } from './errors/chat-moderation.errors.js';
import { revokeChannelBestEffort } from './channel-revoke.service.js';

const logger = createLogger('chat');

type Effect = () => Promise<void>;

type ContextRoomRecord = typeof chatRoom.$inferSelect;

async function runEffects(effects: readonly Effect[]) {
  for (const effect of effects) {
    await effect();
  }
}

function toContextRoom(record: ContextRoomRecord, ref: string, closed: boolean): ChatContextRoom {
  return {
    id: record.id,
    ref,
    name: record.name,
    closed,
    createdAt: record.createdAt.toISOString(),
  };
}

export class ChatContextRoomService implements ChatContextRooms {
  private readonly drizzle: DrizzleService;
  private readonly audit: AuditWritePort;
  private readonly events: EventBus;
  private readonly identityReader: IdentityReader;
  private readonly transport: RealtimeTransport;
  private readonly systemWriter: ChatSystemWriter;

  constructor({
    drizzle,
    audit,
    events,
    identityReader,
    transport,
    systemWriter,
  }: {
    drizzle: DrizzleService;
    audit: AuditWritePort;
    events: EventBus;
    identityReader: IdentityReader;
    transport: RealtimeTransport;
    systemWriter: ChatSystemWriter;
  }) {
    this.drizzle = drizzle;
    this.audit = audit;
    this.events = events;
    this.identityReader = identityReader;
    this.transport = transport;
    this.systemWriter = systemWriter;
  }

  async ensureRoom({ tx, ...input }: Parameters<ChatContextRooms['ensureRoom']>[0]) {
    const { ref, name, memberIds } = EnsureChatContextRoomInputSchema.parse(input);
    return this.write(tx, async (t, effects) => {
      const [inserted] = await t
        .insert(chatRoom)
        .values({
          name,
          slug: `${CONTEXT_ROOM_SLUG_PREFIX}${randomUUID()}`,
          kind: 'context',
          contextRef: ref,
          isPublic: false,
        })
        .onConflictDoNothing({ target: chatRoom.contextRef })
        .returning({ id: chatRoom.id });
      return this.withRoom(t, ref, async (room) => {
        if (inserted) {
          await t.insert(chatRoomConfiguration).values({ roomId: room.id });
          await this.audit.recordInTransaction(t, {
            actorType: 'system',
            action: 'chat.context_room.created',
            resourceType: 'chat_room',
            resourceId: room.id,
            after: { ref, name },
          });
        }
        const addedMemberIds = await this.addMembers(t, room.id, memberIds, effects);
        return {
          room: toContextRoom(room, ref, await this.isClosed(t, room.id)),
          created: inserted !== undefined,
          addedMemberIds,
        };
      });
    });
  }

  async findRoom(ref: string, tx?: unknown) {
    const [row] = await ((tx as DrizzleTx | undefined) ?? this.drizzle.db)
      .select({ room: chatRoom, closed: chatRoomConfiguration.readOnlyMode })
      .from(chatRoom)
      .leftJoin(chatRoomConfiguration, eq(chatRoomConfiguration.roomId, chatRoom.id))
      .where(eq(chatRoom.contextRef, ChatContextRefSchema.parse(ref)))
      .limit(1);
    return row && !row.room.deletedAt ? toContextRoom(row.room, ref, row.closed === true) : null;
  }

  addMember({ ref, userId, tx }: Parameters<ChatContextRooms['addMember']>[0]) {
    return this.write(tx, (t, effects) =>
      this.withRoom(t, ref, async (room) => {
        const added = await this.addMembers(t, room.id, [userId], effects);
        return { added: added.length > 0 };
      }),
    );
  }

  removeMember({ ref, userId, tx }: Parameters<ChatContextRooms['removeMember']>[0]) {
    return this.write(tx, (t, effects) =>
      this.withRoom(t, ref, async (room) => {
        const [removed] = await t
          .delete(chatRoomMember)
          .where(and(eq(chatRoomMember.roomId, room.id), eq(chatRoomMember.userId, userId)))
          .returning({ id: chatRoomMember.id });
        if (!removed) {
          return { removed: false };
        }
        await this.audit.recordInTransaction(t, {
          actorType: 'system',
          action: 'chat.context_room.member.removed',
          resourceType: 'chat_room_member',
          resourceId: removed.id,
          before: { roomId: room.id, userId },
        });
        effects.push(async () => {
          this.events.emit('chat.room.member.removed', {
            roomId: room.id,
            userId,
            removedBy: CHAT_SYSTEM_AUTHOR_ID,
            ip: null,
            userAgent: null,
          });
          await revokeChannelBestEffort(this.transport, userId, room.id);
        });
        return { removed: true };
      }),
    );
  }

  close({ ref, tx }: Parameters<ChatContextRooms['close']>[0]) {
    return this.write(tx, (t, effects) =>
      this.withRoom(t, ref, async (room) => {
        const [closed] = await t
          .insert(chatRoomConfiguration)
          .values({ roomId: room.id, readOnlyMode: true })
          .onConflictDoUpdate({
            target: chatRoomConfiguration.roomId,
            set: { readOnlyMode: true, updatedAt: new Date() },
            setWhere: eq(chatRoomConfiguration.readOnlyMode, false),
          })
          .returning({ id: chatRoomConfiguration.id });
        if (!closed) {
          return { closed: false };
        }
        await this.audit.recordInTransaction(t, {
          actorType: 'system',
          action: 'chat.context_room.closed',
          resourceType: 'chat_room',
          resourceId: room.id,
          before: { readOnlyMode: false },
          after: { readOnlyMode: true },
        });
        const payload: ChatRoomClosedSignal = { roomId: room.id };
        effects.push(() => this.signal(room.id, CHAT_ROOM_CLOSED_SIGNAL, payload));
        return { closed: true };
      }),
    );
  }

  async postSystemEvent({
    ref,
    code,
    params = {},
    tx,
  }: Parameters<ChatContextRooms['postSystemEvent']>[0]) {
    const metadata = SystemEventMetadataSchema.parse({ command: 'system_event', code, params });
    return this.write(tx, (t, effects) =>
      this.withRoom(t, ref, async (room) => {
        const message = await this.systemWriter.postSystemMessage({
          roomId: room.id,
          metadata,
          tx: t,
        });
        effects.push(() => this.publish(room.id, message));
        return { message };
      }),
    );
  }

  private async write<T extends object>(
    tx: unknown,
    fn: (t: DrizzleTx, effects: Effect[]) => Promise<T>,
  ): Promise<ChatContextRoomWrite<T>> {
    const effects: Effect[] = [];
    const result = tx
      ? await fn(tx as DrizzleTx, effects)
      : await this.drizzle.db.transaction((t) => fn(t, effects));
    let pending: Promise<void> | undefined;
    const afterCommit = () => (pending ??= runEffects(effects));
    if (!tx) {
      await afterCommit();
    }
    return { ...result, afterCommit };
  }

  // Same lock as player joins and leaves; taken before any audit write, whose lock is global.
  private async withRoom<T>(
    t: DrizzleTx,
    ref: string,
    fn: (room: ContextRoomRecord) => Promise<T>,
  ) {
    const [room] = await t
      .select()
      .from(chatRoom)
      .where(eq(chatRoom.contextRef, ChatContextRefSchema.parse(ref)))
      .limit(1);
    if (!room || room.deletedAt) {
      throw new ChatContextRoomNotFoundError(ref);
    }
    return withAdvisoryXactLock(t, `chat-room:${room.id}`, () => fn(room));
  }

  private async addMembers(
    t: DrizzleTx,
    roomId: Uuid,
    userIds: readonly Uuid[],
    effects: Effect[],
  ) {
    const unique = [...new Set(userIds)];
    if (unique.length === 0) {
      return [];
    }
    const added = await t
      .insert(chatRoomMember)
      .values(unique.map((userId) => ({ roomId, userId })))
      .onConflictDoNothing()
      .returning({ id: chatRoomMember.id, userId: chatRoomMember.userId });
    await this.audit.recordManyInTransaction(
      t,
      added.map((member) => ({
        actorType: 'system',
        action: 'chat.context_room.member.added',
        resourceType: 'chat_room_member',
        resourceId: member.id,
        after: { roomId, userId: member.userId },
      })),
    );
    const addedUserIds = added.map((member) => member.userId);
    if (addedUserIds.length > 0) {
      effects.push(() => this.emitJoined(roomId, addedUserIds));
    }
    const staff = await this.staffAmong(t, addedUserIds);
    for (const userId of addedUserIds.filter((id) => !staff.has(id))) {
      const payload: ChatMemberJoinedSignal = { roomId, userId };
      effects.push(() => this.signal(roomId, CHAT_MEMBER_JOINED_SIGNAL, payload));
    }
    return addedUserIds;
  }

  // The member list hides staff from ordinary viewers, so their joins are not signalled.
  private async staffAmong(t: DrizzleTx, userIds: Uuid[]) {
    if (userIds.length === 0) {
      return new Set<Uuid>();
    }
    const rows = await t
      .select({ id: user.id })
      .from(user)
      .where(and(inArray(user.id, userIds), inArray(user.role, STAFF_USER_ROLES)));
    return new Set(rows.map((row) => row.id));
  }

  private async emitJoined(roomId: Uuid, userIds: Uuid[]) {
    const playerIds = await this.identityReader.getPlayerIdsByUserIdsSafe(userIds);
    for (const userId of userIds) {
      this.events.emit('chat.room.member.joined', {
        roomId,
        userId,
        playerId: playerIds.get(userId) ?? null,
        auditRecorded: true,
        ip: null,
        userAgent: null,
      });
    }
  }

  private async isClosed(t: DrizzleTx, roomId: Uuid) {
    const [config] = await t
      .select({ readOnlyMode: chatRoomConfiguration.readOnlyMode })
      .from(chatRoomConfiguration)
      .where(eq(chatRoomConfiguration.roomId, roomId))
      .limit(1);
    return config?.readOnlyMode === true;
  }

  private async signal(roomId: Uuid, name: string, payload: unknown) {
    try {
      await this.transport.signal?.(chatChannel(roomId), name, payload);
    } catch (err: unknown) {
      logger.error({ err, roomId, name }, 'chat context room signal failed');
    }
  }

  private async publish(roomId: Uuid, message: unknown) {
    try {
      await this.transport.publish(chatChannel(roomId), message);
    } catch (err: unknown) {
      logger.error({ err, roomId }, 'chat context room publish failed');
    }
  }
}

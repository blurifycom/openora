import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import {
  createTestDb,
  createTestRedis,
  RedisPubSubRealtimeTransport,
  type TestDb,
  type TestRedis,
} from '@openora/core/testing';
import { user } from '@openora/core/pam/schema/identity';
import { migrate as migrateIdentity } from '@openora/core/pam/migrate/identity';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import {
  ACCESS_REVOKED_SIGNAL,
  CHAT_SYSTEM_AUTHOR_ID,
  chatChannel,
  SYSTEM_EVENT_PARAM_VALUE_MAX_LENGTH,
  SYSTEM_EVENT_PARAMS_MAX_BYTES,
  type AdminUserDirectory,
  type RealtimeSignal,
} from '@openora/core/contracts';
import {
  NO_CLIENT_META,
  makeAuditWriter,
  makeEventBus,
  makeIdentityReader,
  mock,
} from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { ChatMessageSchema, type ChatMessage } from '../contract/index.js';
import { CHAT_MEMBER_JOINED_SIGNAL, CHAT_ROOM_CLOSED_SIGNAL } from '../contract/constants.js';
import { chatMessage, chatRoom, chatRoomConfiguration, chatRoomMember } from '../schema/index.js';
import { ChatRoomProtectedError, ChatService } from '../service/chat.service.js';
import { ChatModerationService } from '../service/chat-moderation.service.js';
import { ChatRoomMembershipService } from '../service/chat-room-membership.service.js';
import { ChatContextRoomService } from '../service/chat-context-room.service.js';
import {
  ChatContextRoomNotFoundError,
  ChatPlayerMutedError,
  ChatRoomNotFoundError,
  ChatRoomNotMemberError,
  ChatRoomNotModeratorError,
  ChatSystemMessageProtectedError,
} from '../service/errors/chat-moderation.errors.js';

let db: TestDb;
let redis: TestRedis;
const transports: RedisPubSubRealtimeTransport[] = [];

function makeServices() {
  const serviceName = `chat-context-test-${randomUUID()}`;
  const transport = new RedisPubSubRealtimeTransport(redis.client, serviceName);
  transports.push(transport);
  const events = makeEventBus();
  const audit = makeAuditWriter();
  const identityReader = makeIdentityReader();
  const moderation = new ChatModerationService(db.drizzle, transport, audit, events);
  const chat = new ChatService({
    drizzle: db.drizzle,
    events,
    transport,
    directory: mock<AdminUserDirectory>({ lookupPlayers: async () => [] }),
    audit,
    moderation,
    identityReader,
    allowedAttachmentHosts: [],
  });
  const membership = new ChatRoomMembershipService(
    db.drizzle,
    events,
    audit,
    transport,
    identityReader,
  );
  const context = new ChatContextRoomService({
    drizzle: db.drizzle,
    audit,
    events,
    identityReader,
    transport,
    systemWriter: chat,
  });
  return { chat, moderation, membership, context, transport, audit, events, serviceName };
}

type Services = ReturnType<typeof makeServices>;

async function subscribeSignals(services: Services, roomId: string, userId: string) {
  const signals: RealtimeSignal[] = [];
  services.transport.subscribeSignal?.(chatChannel(roomId), (s) => signals.push(s), userId);
  await waitForRedisSubscriber(`oss:rt:${services.serviceName}:signal:${chatChannel(roomId)}`);
  return signals;
}

async function subscribeMessages(services: Services, roomId: string, userId: string) {
  const messages: ChatMessage[] = [];
  services.transport.subscribe<ChatMessage>(chatChannel(roomId), (m) => messages.push(m), userId);
  await waitForRedisSubscriber(`oss:rt:${services.serviceName}:${chatChannel(roomId)}`);
  return messages;
}

async function waitForRedisSubscriber(key: string) {
  await vi.waitFor(async () => {
    const result = await redis.client.sendCommand<string[]>(['PUBSUB', 'NUMSUB', key]);
    expect(Number(result[1])).toBeGreaterThan(0);
  });
}

async function waitForAdvisoryLockWaiter() {
  await vi.waitFor(async () => {
    const { rows } = await db.drizzle.db.execute<{ waiting: number }>(
      sql`select count(*)::int as waiting from pg_locks
          where locktype = 'advisory' and not granted
            and database = (select oid from pg_database where datname = current_database())`,
    );
    expect(rows[0]?.waiting ?? 0).toBeGreaterThan(0);
  });
}

function send(services: Services, roomId: string, userId: string, content = 'gg') {
  return services.chat.sendRoomMessage({ userId, username: 'player', roomId, content });
}

beforeAll(async () => {
  db = await createTestDb([migrate, migrateIdentity, migrateProfile]);
  redis = await createTestRedis();
});

afterAll(async () => {
  await db.drop();
  await redis.quit();
});

afterEach(async () => {
  await Promise.allSettled(transports.splice(0).map((t) => t.close()));
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${chatMessage}, ${chatRoomConfiguration}, ${chatRoomMember}, ${chatRoom}, ${user} RESTART IDENTITY CASCADE`,
  );
});

describe('ChatContextRoomService.ensureRoom (real PG)', () => {
  it('creates one room per ref and adds only the members not yet in it', async () => {
    const services = makeServices();
    const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
    const ref = `ctx:${randomUUID()}`;

    const first = await services.context.ensureRoom({ ref, name: 'Context', memberIds: [a, b] });
    const second = await services.context.ensureRoom({ ref, name: 'Renamed', memberIds: [b, c] });

    expect(first).toMatchObject({ created: true, addedMemberIds: [a, b] });
    expect(second).toMatchObject({ created: false, addedMemberIds: [c] });
    expect(second.room).toEqual(first.room);
    expect(first.room).toMatchObject({ ref, name: 'Context', closed: false });
    const members = await db.drizzle.db
      .select({ userId: chatRoomMember.userId, role: chatRoomMember.role })
      .from(chatRoomMember)
      .where(eq(chatRoomMember.roomId, first.room.id));
    expect(members.map((m) => m.userId).sort()).toEqual([a, b, c].sort());
    expect(new Set(members.map((m) => m.role))).toEqual(new Set(['member']));
    const [stored] = await db.drizzle.db
      .select()
      .from(chatRoom)
      .where(eq(chatRoom.id, first.room.id));
    expect(stored).toMatchObject({
      kind: 'context',
      contextRef: ref,
      isPublic: false,
      joinCode: null,
      creatorId: null,
    });
  });

  it('settles concurrent calls for one ref on a single room', async () => {
    const services = makeServices();
    const ref = `ctx:${randomUUID()}`;
    const memberIds = [randomUUID(), randomUUID()];

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        services.context.ensureRoom({ ref, name: 'Context', memberIds }),
      ),
    );

    expect(new Set(results.map((r) => r.room.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(results.flatMap((r) => r.addedMemberIds).sort()).toEqual([...memberIds].sort());
    const rooms = await db.drizzle.db.select().from(chatRoom).where(eq(chatRoom.contextRef, ref));
    expect(rooms).toHaveLength(1);
  });

  it('audits the creation and each added member inside the write', async () => {
    const services = makeServices();
    const memberId = randomUUID();

    const { room } = await services.context.ensureRoom({
      ref: 'ctx:audit',
      name: 'Context',
      memberIds: [memberId],
    });

    expect(services.audit.recordInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorType: 'system',
        action: 'chat.context_room.created',
        resourceId: room.id,
      }),
    );
    expect(services.audit.recordManyInTransaction).toHaveBeenCalledWith(expect.anything(), [
      expect.objectContaining({
        actorType: 'system',
        action: 'chat.context_room.member.added',
        after: { roomId: room.id, userId: memberId },
      }),
    ]);
  });

  it("writes nothing when the caller's transaction rolls back", async () => {
    const services = makeServices();
    const ref = 'ctx:rolled-back';

    await expect(
      db.drizzle.db.transaction(async (tx) => {
        await services.context.ensureRoom({ ref, name: 'Context', memberIds: [randomUUID()], tx });
        throw new Error('caller failed');
      }),
    ).rejects.toThrow('caller failed');

    expect(await services.context.findRoom(ref)).toBeNull();
  });

  it('rejects a ref with surrounding whitespace', async () => {
    const services = makeServices();

    await expect(
      services.context.ensureRoom({ ref: ' ctx:padded ', name: 'Context', memberIds: [] }),
    ).rejects.toThrow();
    await expect(services.context.findRoom('ctx:padded ')).rejects.toThrow();
  });

  it('refuses an admin delete, so the ref keeps resolving', async () => {
    const services = makeServices();
    const ref = 'ctx:admin-delete';
    const { room } = await services.context.ensureRoom({ ref, name: 'Context', memberIds: [] });

    await expect(
      services.chat.deleteRoom(room.id, randomUUID(), NO_CLIENT_META),
    ).rejects.toBeInstanceOf(ChatRoomProtectedError);
    await expect(
      services.context.ensureRoom({ ref, name: 'Context', memberIds: [] }),
    ).resolves.toMatchObject({ created: false, room: { id: room.id } });
  });

  it('rejects a write for an unknown ref', async () => {
    const services = makeServices();

    await expect(
      services.context.addMember({ ref: 'ctx:missing', userId: randomUUID() }),
    ).rejects.toBeInstanceOf(ChatContextRoomNotFoundError);
  });
});

describe('Context room visibility (real PG)', () => {
  it('keeps the room out of a member’s room list and connection channels', async () => {
    const services = makeServices();
    const memberId = randomUUID();
    const { room } = await services.context.ensureRoom({
      ref: 'ctx:hidden',
      name: 'Context',
      memberIds: [memberId],
    });
    const privateRoom = await services.chat.createPrivateRoom({
      userId: memberId,
      name: 'Mine',
      ...NO_CLIENT_META,
    });

    const listed = await services.chat.listRooms(memberId);

    expect(listed.map((r) => r.id)).toEqual([privateRoom.id]);
    expect(listed.map((r) => r.id)).not.toContain(room.id);
  });

  it('denies a non-member its history, its stream and posting', async () => {
    const services = makeServices();
    const outsiderId = randomUUID();
    const { room } = await services.context.ensureRoom({
      ref: 'ctx:members-only',
      name: 'Context',
      memberIds: [randomUUID()],
    });

    await expect(
      services.chat.getRoomMessages({ roomId: room.id, viewerId: outsiderId }),
    ).rejects.toBeInstanceOf(ChatRoomNotMemberError);
    await expect(services.chat.verifyChannelAccess(room.id, outsiderId)).rejects.toBeInstanceOf(
      ChatRoomNotMemberError,
    );
    await expect(send(services, room.id, outsiderId)).rejects.toBeInstanceOf(
      ChatRoomNotMemberError,
    );
  });

  it('lets a member read, stream and post', async () => {
    const services = makeServices();
    const memberId = randomUUID();
    const { room } = await services.context.ensureRoom({
      ref: 'ctx:member',
      name: 'Context',
      memberIds: [memberId],
    });

    await expect(services.chat.verifyChannelAccess(room.id, memberId)).resolves.toBe(room.id);
    await send(services, room.id, memberId, 'good luck');

    const messages = await services.chat.getRoomMessages({ roomId: room.id, viewerId: memberId });
    expect(messages.map((m) => m.content)).toEqual(['good luck']);
  });

  it('does not let a player leave a context room', async () => {
    const services = makeServices();
    const memberId = randomUUID();
    const { room } = await services.context.ensureRoom({
      ref: 'ctx:no-leave',
      name: 'Context',
      memberIds: [memberId],
    });

    await expect(
      services.membership.leaveRoom({ userId: memberId, roomId: room.id, ...NO_CLIENT_META }),
    ).rejects.toBeInstanceOf(ChatRoomNotFoundError);
  });
});

describe('ChatContextRoomService membership (real PG)', () => {
  it('signals a join, and ends a removed member’s stream and access', async () => {
    const services = makeServices();
    const memberId = randomUUID();
    const joinerId = randomUUID();
    const ref = 'ctx:membership';
    const { room } = await services.context.ensureRoom({
      ref,
      name: 'Context',
      memberIds: [memberId],
    });
    const signals = await subscribeSignals(services, room.id, memberId);

    await expect(services.context.addMember({ ref, userId: joinerId })).resolves.toMatchObject({
      added: true,
    });
    await expect(services.context.addMember({ ref, userId: joinerId })).resolves.toMatchObject({
      added: false,
    });
    await vi.waitFor(() =>
      expect(signals).toContainEqual({
        name: CHAT_MEMBER_JOINED_SIGNAL,
        payload: { roomId: room.id, userId: joinerId },
      }),
    );

    await expect(services.context.removeMember({ ref, userId: memberId })).resolves.toMatchObject({
      removed: true,
    });

    expect(signals).toContainEqual({
      name: ACCESS_REVOKED_SIGNAL,
      payload: { channel: chatChannel(room.id) },
    });
    await expect(services.chat.verifyChannelAccess(room.id, memberId)).rejects.toBeInstanceOf(
      ChatRoomNotMemberError,
    );
    expect(services.audit.recordInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'chat.context_room.member.removed',
        before: { roomId: room.id, userId: memberId },
      }),
    );
    expect(services.events.emit).toHaveBeenCalledWith(
      'chat.room.member.joined',
      expect.objectContaining({ roomId: room.id, userId: joinerId, auditRecorded: true }),
    );
    expect(services.events.emit).toHaveBeenCalledWith(
      'chat.room.member.removed',
      expect.objectContaining({
        roomId: room.id,
        userId: memberId,
        removedBy: CHAT_SYSTEM_AUTHOR_ID,
      }),
    );
  });

  it('refuses a send that passed its checks before the removal committed', async () => {
    const services = makeServices();
    const memberId = randomUUID();
    const ref = 'ctx:remove-race';
    const { room } = await services.context.ensureRoom({
      ref,
      name: 'Context',
      memberIds: [memberId],
    });

    const { sent } = await db.drizzle.db.transaction(async (tx) => {
      await services.context.removeMember({ ref, userId: memberId, tx });
      const racing = send(services, room.id, memberId, 'racing');
      racing.catch(() => undefined);
      await waitForAdvisoryLockWaiter();
      return { sent: racing };
    });

    await expect(sent).rejects.toBeInstanceOf(ChatRoomNotMemberError);
    expect(
      await db.drizzle.db.select().from(chatMessage).where(eq(chatMessage.roomId, room.id)),
    ).toEqual([]);
    expect(services.events.emit).toHaveBeenCalledWith(
      'identity.user.unauthorized_access',
      expect.objectContaining({ userId: memberId, resource: 'chat.message', action: 'send' }),
    );
  });

  it('does not signal a staff member joining', async () => {
    const services = makeServices();
    const memberId = randomUUID();
    const staffId = randomUUID();
    await db.drizzle.db.insert(user).values({
      id: staffId,
      name: 'Staff',
      username: `staff_${staffId.replaceAll('-', '').slice(0, 13)}`,
      email: `${staffId}@staff.test`,
      role: 'admin',
    });
    const ref = 'ctx:staff-join';
    const { room } = await services.context.ensureRoom({
      ref,
      name: 'Context',
      memberIds: [memberId],
    });
    const signals = await subscribeSignals(services, room.id, memberId);

    await services.context.addMember({ ref, userId: staffId });
    await services.context.addMember({ ref, userId: randomUUID() });

    await vi.waitFor(() =>
      expect(signals.filter((s) => s.name === CHAT_MEMBER_JOINED_SIGNAL)).toHaveLength(1),
    );
    expect(signals).not.toContainEqual({
      name: CHAT_MEMBER_JOINED_SIGNAL,
      payload: { roomId: room.id, userId: staffId },
    });
  });

  it("holds the revoke until the caller's transaction has committed", async () => {
    const services = makeServices();
    const memberId = randomUUID();
    const ref = 'ctx:deferred-revoke';
    const { room } = await services.context.ensureRoom({
      ref,
      name: 'Context',
      memberIds: [memberId],
    });
    const signals = await subscribeSignals(services, room.id, memberId);

    const write = await db.drizzle.db.transaction((tx) =>
      services.context.removeMember({ ref, userId: memberId, tx }),
    );
    expect(signals).toEqual([]);
    expect(services.events.emit).not.toHaveBeenCalledWith(
      'chat.room.member.removed',
      expect.anything(),
    );

    await write.afterCommit();

    expect(signals).toEqual([
      { name: ACCESS_REVOKED_SIGNAL, payload: { channel: chatChannel(room.id) } },
    ]);
  });
});

describe('ChatContextRoomService.close (real PG)', () => {
  it('stops members posting while history stays readable', async () => {
    const services = makeServices();
    const memberId = randomUUID();
    const ref = 'ctx:closed';
    const { room } = await services.context.ensureRoom({
      ref,
      name: 'Context',
      memberIds: [memberId],
    });
    await send(services, room.id, memberId, 'before close');
    const signals = await subscribeSignals(services, room.id, memberId);

    await expect(services.context.close({ ref })).resolves.toMatchObject({ closed: true });
    await expect(services.context.close({ ref })).resolves.toMatchObject({ closed: false });

    const rejected = send(services, room.id, memberId, 'after close');
    await expect(rejected).rejects.toBeInstanceOf(ChatPlayerMutedError);
    await expect(rejected).rejects.toMatchObject({ data: { reason: 'read_only' } });
    const history = await services.chat.getRoomMessages({ roomId: room.id, viewerId: memberId });
    expect(history.map((m) => m.content)).toEqual(['before close']);
    expect(await services.context.findRoom(ref)).toMatchObject({ id: room.id, closed: true });
    await vi.waitFor(() =>
      expect(signals).toEqual([{ name: CHAT_ROOM_CLOSED_SIGNAL, payload: { roomId: room.id } }]),
    );
  });

  it('refuses a send that passed its checks before the close committed', async () => {
    const services = makeServices();
    const memberId = randomUUID();
    const ref = 'ctx:close-race';
    const { room } = await services.context.ensureRoom({
      ref,
      name: 'Context',
      memberIds: [memberId],
    });

    const { sent } = await db.drizzle.db.transaction(async (tx) => {
      await services.context.close({ ref, tx });
      const racing = send(services, room.id, memberId, 'racing');
      racing.catch(() => undefined);
      await waitForAdvisoryLockWaiter();
      return { sent: racing };
    });

    await expect(sent).rejects.toMatchObject({ data: { reason: 'read_only' } });
    expect(
      await db.drizzle.db.select().from(chatMessage).where(eq(chatMessage.roomId, room.id)),
    ).toEqual([]);
  });
});

describe('Context room system events (real PG)', () => {
  it('round-trips a system event through history and the live stream', async () => {
    const services = makeServices();
    const memberId = randomUUID();
    const ref = 'ctx:events';
    const { room } = await services.context.ensureRoom({
      ref,
      name: 'Context',
      memberIds: [memberId],
    });
    const live = await subscribeMessages(services, room.id, memberId);

    const { message } = await services.context.postSystemEvent({
      ref,
      code: 'item.settled',
      params: { label: 'first', ratio: 2.5, done: false, note: null },
    });

    const history = await services.chat.getRoomMessages({ roomId: room.id, viewerId: memberId });
    expect(history).toHaveLength(1);
    const [stored] = history;
    expect(ChatMessageSchema.parse(stored).metadata).toEqual(stored?.metadata);
    expect(stored).toMatchObject({
      id: message.id,
      type: 'system',
      actorId: CHAT_SYSTEM_AUTHOR_ID,
      metadata: {
        command: 'system_event',
        code: 'item.settled',
        params: { label: 'first', ratio: 2.5, done: false, note: null },
      },
    });
    await vi.waitFor(() => expect(live.map((m) => m.id)).toEqual([message.id]));
  });

  it('can still post to a closed room', async () => {
    const services = makeServices();
    const ref = 'ctx:closed-events';
    await services.context.ensureRoom({ ref, name: 'Context', memberIds: [] });
    await services.context.close({ ref });

    await expect(
      services.context.postSystemEvent({ ref, code: 'item.archived' }),
    ).resolves.toMatchObject({ message: { metadata: { command: 'system_event', params: {} } } });
  });

  it("publishes only once the caller's transaction has committed", async () => {
    const services = makeServices();
    const memberId = randomUUID();
    const ref = 'ctx:deferred-publish';
    const { room } = await services.context.ensureRoom({
      ref,
      name: 'Context',
      memberIds: [memberId],
    });
    const live = await subscribeMessages(services, room.id, memberId);

    const write = await db.drizzle.db.transaction((tx) =>
      services.context.postSystemEvent({ ref, code: 'item.started', tx }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(live).toEqual([]);

    await write.afterCommit();

    await vi.waitFor(() => expect(live.map((m) => m.id)).toEqual([write.message.id]));
  });

  it('keeps post order in history for events written in one transaction', async () => {
    const services = makeServices();
    const memberId = randomUUID();
    const ref = 'ctx:same-tx-order';
    const { room } = await services.context.ensureRoom({
      ref,
      name: 'Context',
      memberIds: [memberId],
    });

    const ids = await db.drizzle.db.transaction(async (tx) => {
      const posted: string[] = [];
      for (let step = 0; step < 20; step++) {
        const { message } = await services.context.postSystemEvent({
          ref,
          code: 'item.step',
          params: { step },
          tx,
        });
        posted.push(message.id);
      }
      return posted;
    });

    const history = await services.chat.getRoomMessages({ roomId: room.id, viewerId: memberId });
    expect(history.map((m) => m.id)).toEqual([...ids].reverse());
  });

  it('rejects a malformed event code', async () => {
    const services = makeServices();
    const ref = 'ctx:bad-code';
    await services.context.ensureRoom({ ref, name: 'Context', memberIds: [] });

    await expect(services.context.postSystemEvent({ ref, code: '' })).rejects.toThrow();
  });

  it('rejects params past the byte cap or with an empty key', async () => {
    const services = makeServices();
    const ref = 'ctx:bad-params';
    await services.context.ensureRoom({ ref, name: 'Context', memberIds: [] });
    const value = 'x'.repeat(SYSTEM_EVENT_PARAM_VALUE_MAX_LENGTH);
    const keys = Math.ceil(SYSTEM_EVENT_PARAMS_MAX_BYTES / value.length) + 1;
    const oversized = Object.fromEntries(Array.from({ length: keys }, (_, i) => [`k${i}`, value]));

    await expect(
      services.context.postSystemEvent({ ref, code: 'item.notice', params: oversized }),
    ).rejects.toThrow();
    await expect(
      services.context.postSystemEvent({ ref, code: 'item.notice', params: { '': 1 } }),
    ).rejects.toThrow();
  });
});

describe('Deleting system messages (real PG)', () => {
  async function privateRoomWithSystemMessage(services: Services) {
    const ownerId = randomUUID();
    const room = await services.chat.createPrivateRoom({
      userId: ownerId,
      name: 'Room',
      ...NO_CLIENT_META,
    });
    const message = await services.chat.postSystemMessage({
      roomId: room.id,
      metadata: { command: 'system_event', code: 'notice', params: {} },
    });
    return { ownerId, room, message };
  }

  it('refuses a room owner', async () => {
    const services = makeServices();
    const { ownerId, message } = await privateRoomWithSystemMessage(services);

    await expect(
      services.chat.deleteMessage(message.id, ownerId, NO_CLIENT_META),
    ).rejects.toBeInstanceOf(ChatSystemMessageProtectedError);
    expect(services.events.emit).toHaveBeenCalledWith(
      'identity.user.unauthorized_access',
      expect.objectContaining({ userId: ownerId, resource: 'chat.message', action: 'delete' }),
    );
    const [stored] = await db.drizzle.db
      .select({ isDeleted: chatMessage.isDeleted })
      .from(chatMessage)
      .where(eq(chatMessage.id, message.id));
    expect(stored?.isDeleted).toBe(false);
  });

  it('refuses a context room member', async () => {
    const services = makeServices();
    const memberId = randomUUID();
    const ref = 'ctx:delete';
    await services.context.ensureRoom({ ref, name: 'Context', memberIds: [memberId] });
    const { message } = await services.context.postSystemEvent({ ref, code: 'item.started' });

    await expect(
      services.chat.deleteMessage(message.id, memberId, NO_CLIENT_META),
    ).rejects.toBeInstanceOf(ChatRoomNotModeratorError);
  });

  it('still lets staff delete one', async () => {
    const services = makeServices();
    const { message } = await privateRoomWithSystemMessage(services);

    await expect(
      services.moderation.deleteMessage(message.id, randomUUID(), NO_CLIENT_META, 'admin'),
    ).resolves.toEqual({ success: true });
  });

  it('still lets a moderator delete a player message', async () => {
    const services = makeServices();
    const { ownerId, room } = await privateRoomWithSystemMessage(services);
    const sent = await send(services, room.id, ownerId);

    await expect(services.chat.deleteMessage(sent.id, ownerId, NO_CLIENT_META)).resolves.toEqual({
      success: true,
    });
  });
});

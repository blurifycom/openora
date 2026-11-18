import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import {
  ADMIN_GUARD,
  Container,
  DRIZZLE,
  DrizzleOutboxWriter,
  EVENT_BUS,
  ModuleRegistryImpl,
  DrizzleProcessedEventLog,
  OutboxRelay,
  createEventBus,
  eventOutbox,
  processedEvents,
  type CoreTokenCatalog,
} from '@openora/core/server';
import { migrate as migrateOutbox } from '@openora/core/server/migrate';
import { migrate as migrateIdentity } from '@openora/core/pam/migrate/identity';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { user } from '@openora/core/pam/schema/identity';
import {
  ADMIN_USER_DIRECTORY,
  AUDIT_WRITER,
  CHAT_CONTEXT_ROOM_COMMANDS,
  CHAT_CONTEXT_ROOMS,
  CHAT_SYSTEM_AUTHOR_ID,
  IDENTITY_READER,
  JOB_QUEUE,
  RATE_LIMITER,
  REALTIME_CLIENT_AUTHORIZER,
  REALTIME_TRANSPORT,
  type AdminUserDirectory,
  type BrokerHandler,
  type EventEnvelope,
  type JobQueueAdapter,
  type MessageBrokerAdapter,
  type RealtimeTransport,
} from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import {
  makeAuditWriter,
  makeChatContextSendPolicy,
  makeIdentityReader,
  mock,
} from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { chatMessage, chatRoom, chatRoomConfiguration, chatRoomMember } from '../schema/index.js';
import { ChatService } from '../service/chat.service.js';
import { ChatModerationService } from '../service/chat-moderation.service.js';
import { OutboxChatContextRoomCommands } from '../service/outbox-chat-context-room-commands.service.js';
import {
  ChatContextRoomIdConflictError,
  ChatContextRoomNotFoundError,
  ChatPlayerMutedError,
  ChatSystemCardRefusedError,
} from '../service/errors/chat-moderation.errors.js';
import chatPlugin from '../plugin.js';

const TOPIC = 'chat.context_room.command_issued';

let db: TestDb;

// Publishing only records; the test delivers, so it can reorder and redeliver like the broker.
function manualBroker() {
  const handlers = new Map<string, BrokerHandler[]>();
  const published: EventEnvelope[] = [];
  const broker: MessageBrokerAdapter = {
    async publish(envelope) {
      published.push(envelope);
    },
    subscribe(topic, handler) {
      handlers.set(topic, [...(handlers.get(topic) ?? []), handler]);
      return () => {};
    },
    close: async () => {},
  };
  const deliver = async (envelope: EventEnvelope) => {
    for (const handler of handlers.get(envelope.topic) ?? []) {
      await handler(envelope);
    }
  };
  // Like the broker: what throws is redelivered after the rest. The relay orders by occurredAt
  // alone, so two commands of one transaction can come out in either order.
  const deliverAll = async (envelopes: EventEnvelope[]) => {
    const failed: EventEnvelope[] = [];
    for (const envelope of envelopes) {
      await deliver(envelope).catch(() => failed.push(envelope));
    }
    for (const envelope of failed) {
      await deliver(envelope);
    }
  };
  // The commands relayed since the last call, in outbox order.
  const takeCommands = () => published.splice(0).filter((envelope) => envelope.topic === TOPIC);
  return { broker, deliver, deliverAll, takeCommands };
}

// The chat plugin as createApp wires it: registered, its router factory run (it builds the
// services its handlers use), and its command handler subscribed under its own consumer id.
function setup() {
  const { broker, deliver, deliverAll, takeCommands } = manualBroker();
  const bus = createEventBus({
    broker,
    outbox: new DrizzleOutboxWriter(),
    processedEvents: new DrizzleProcessedEventLog(db.drizzle.db),
  });
  const publish = vi.fn(async () => undefined);
  const signal = vi.fn(async () => undefined);
  const transport = mock<RealtimeTransport>({ publish, signal });
  const audit = makeAuditWriter();
  const container = new Container<CoreTokenCatalog>();
  container.register(DRIZZLE, () => db.drizzle);
  container.register(EVENT_BUS, () => bus);
  container.register(JOB_QUEUE, () => mock<JobQueueAdapter>({ schedule: async () => {} }));
  container.register(REALTIME_TRANSPORT, () => transport);
  container.register(REALTIME_CLIENT_AUTHORIZER, () => mock());
  container.register(RATE_LIMITER, () => mock());
  container.register(ADMIN_USER_DIRECTORY, () => mock<AdminUserDirectory>());
  container.register(AUDIT_WRITER, () => audit);
  container.register(IDENTITY_READER, () => makeIdentityReader());
  container.register(ADMIN_GUARD, () => mock());
  const registry = new ModuleRegistryImpl<CoreTokenCatalog>(container);
  registry.setOwner('chat');
  chatPlugin.register(registry);
  registry.routers.getAll().get('chat')?.(container);
  const [subscription] = registry.events.getAll().get(TOPIC) ?? [];
  if (!subscription) {
    throw new Error('chat plugin registered no context room command handler');
  }
  bus.on(TOPIC, subscription.handler, { consumer: subscription.consumer });
  const chat = new ChatService({
    drizzle: db.drizzle,
    events: bus,
    transport,
    directory: mock<AdminUserDirectory>({ lookupPlayers: async () => [] }),
    audit,
    moderation: new ChatModerationService(db.drizzle, transport, audit, bus),
    identityReader: makeIdentityReader(),
    allowedAttachmentHosts: [],
    contextSendPolicy: makeChatContextSendPolicy(),
  });
  const relay = new OutboxRelay(db.drizzle.db, broker);
  const relayAndApply = async () => {
    await relay.drainOnce();
    await deliverAll(takeCommands());
  };
  return {
    commands: new OutboxChatContextRoomCommands(bus, db.drizzle),
    local: container.get(CHAT_CONTEXT_ROOM_COMMANDS),
    rooms: container.get(CHAT_CONTEXT_ROOMS),
    relay,
    deliver,
    deliverAll,
    takeCommands,
    relayAndApply,
    chat,
    publish,
    signal,
  };
}

const roomById = async (id: string) =>
  (await db.drizzle.db.select().from(chatRoom).where(eq(chatRoom.id, id)))[0];
const roomsWithRef = (ref: string) =>
  db.drizzle.db.select().from(chatRoom).where(eq(chatRoom.contextRef, ref));
const memberIds = async (roomId: string) =>
  (
    await db.drizzle.db
      .select({ userId: chatRoomMember.userId })
      .from(chatRoomMember)
      .where(eq(chatRoomMember.roomId, roomId))
  )
    .map((row) => row.userId)
    .sort();
const messagesWithId = (id: string) =>
  db.drizzle.db.select().from(chatMessage).where(eq(chatMessage.id, id));
const isClosed = async (roomId: string) =>
  (
    await db.drizzle.db
      .select({ readOnlyMode: chatRoomConfiguration.readOnlyMode })
      .from(chatRoomConfiguration)
      .where(eq(chatRoomConfiguration.roomId, roomId))
  )[0]?.readOnlyMode === true;

const send = (chat: ChatService, roomId: string, userId: string) =>
  chat.sendRoomMessage({ userId, username: 'player', roomId, content: 'gg' });

beforeAll(async () => {
  db = await createTestDb([migrateOutbox, migrate, migrateIdentity, migrateProfile]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${eventOutbox}, ${processedEvents}, ${chatMessage}, ${chatRoomConfiguration}, ${chatRoomMember}, ${chatRoom}, ${user} RESTART IDENTITY CASCADE`,
  );
});

describe('context room commands through the outbox (real PG)', () => {
  it('commits the commands with the caller tx, and chat applies them once relayed', async () => {
    const { commands, relayAndApply, publish } = setup();
    const ref = `match:${randomUUID()}`;
    const roomId = randomUUID();
    const messageId = randomUUID();
    const [a, b] = [randomUUID(), randomUUID()];

    await db.drizzle.db.transaction(async (tx) => {
      await commands.ensureRoom({ ref, roomId, name: 'Match', memberIds: [a, b], tx });
      await commands.postSystemEvent({ ref, messageId, code: 'match.started', tx });
    });

    expect(await db.drizzle.db.select().from(eventOutbox)).toHaveLength(2);
    expect(await roomsWithRef(ref)).toHaveLength(0);
    await relayAndApply();
    expect(await roomById(roomId)).toMatchObject({ kind: 'context', contextRef: ref });
    expect(await memberIds(roomId)).toEqual([a, b].sort());
    expect((await messagesWithId(messageId))[0]).toMatchObject({
      roomId,
      userId: CHAT_SYSTEM_AUTHOR_ID,
      type: 'system',
      metadata: { command: 'system_event', code: 'match.started', params: {} },
    });
    await vi.waitFor(() =>
      expect(publish).toHaveBeenCalledWith(
        `chat:room:${roomId}`,
        expect.objectContaining({ id: messageId, type: 'system' }),
      ),
    );
  });

  it('leaves no outbox row and no room when the caller tx rolls back', async () => {
    const { commands, relayAndApply } = setup();
    const ref = `match:${randomUUID()}`;
    const roomId = randomUUID();

    await expect(
      db.drizzle.db.transaction(async (tx) => {
        await commands.ensureRoom({ ref, roomId, name: 'Match', memberIds: [randomUUID()], tx });
        await commands.postSystemEvent({ ref, messageId: randomUUID(), code: 'match.started', tx });
        throw new Error('payout refused');
      }),
    ).rejects.toThrow('payout refused');

    expect(await db.drizzle.db.select().from(eventOutbox)).toHaveLength(0);
    await relayAndApply();
    expect(await roomsWithRef(ref)).toHaveLength(0);
  });

  it('keeps one room and one message when a command is delivered twice or issued twice', async () => {
    const { commands, relayAndApply, deliverAll, relay, takeCommands, publish } = setup();
    const ref = `match:${randomUUID()}`;
    const roomId = randomUUID();
    const messageId = randomUUID();
    const a = randomUUID();
    const issue = () =>
      db.drizzle.db.transaction(async (tx) => {
        await commands.ensureRoom({ ref, roomId, name: 'Match', memberIds: [a], tx });
        await commands.postSystemEvent({ ref, messageId, code: 'match.started', tx });
      });

    await issue();
    await relay.drainOnce();
    const envelopes = takeCommands();
    await deliverAll([...envelopes, ...envelopes]);
    await issue();
    await relayAndApply();

    expect(await roomsWithRef(ref)).toEqual([expect.objectContaining({ id: roomId })]);
    expect(await memberIds(roomId)).toEqual([a]);
    expect(await messagesWithId(messageId)).toHaveLength(1);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('converges when posts arrive before the ensure, in the order they were issued', async () => {
    const { commands, deliver, relay, takeCommands } = setup();
    const ref = `match:${randomUUID()}`;
    const roomId = randomUUID();
    const [first, second] = [randomUUID(), randomUUID()];
    const a = randomUUID();
    await commands.postSystemEvent({ ref, messageId: first, code: 'match.started' });
    await commands.ensureRoom({ ref, roomId, name: 'Match', memberIds: [a] });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await commands.postSystemEvent({ ref, messageId: second, code: 'match.settled' });
    await relay.drainOnce();
    const [firstPost, ensure, secondPost] = takeCommands();

    await expect(deliver(firstPost!)).rejects.toBeInstanceOf(ChatContextRoomNotFoundError);
    await deliver(ensure!);
    await deliver(secondPost!);
    // The broker's redelivery of the one that threw.
    await deliver(firstPost!);

    expect(await memberIds(roomId)).toEqual([a]);
    const [firstCard] = await messagesWithId(first);
    const [secondCard] = await messagesWithId(second);
    expect(firstCard).toMatchObject({ roomId, createdAt: new Date(firstPost!.occurredAt) });
    expect(secondCard).toMatchObject({ roomId, createdAt: new Date(secondPost!.occurredAt) });
    expect(firstCard!.createdAt.getTime()).toBeLessThan(secondCard!.createdAt.getTime());
    expect(await db.drizzle.db.select().from(processedEvents)).toHaveLength(3);
  });

  it('keeps a closed room closed: system posts land, a member post is refused, a re-ensure adds nobody', async () => {
    const { commands, relayAndApply, chat, signal } = setup();
    const ref = `match:${randomUUID()}`;
    const roomId = randomUUID();
    const messageId = randomUUID();
    const a = randomUUID();
    await commands.ensureRoom({ ref, roomId, name: 'Match', memberIds: [a] });
    await relayAndApply();
    await send(chat, roomId, a);

    await commands.close({ ref });
    await commands.postSystemEvent({ ref, messageId, code: 'match.settled' });
    const late = randomUUID();
    await commands.ensureRoom({ ref, roomId, name: 'Match', memberIds: [a, late] });
    await relayAndApply();

    expect(await isClosed(roomId)).toBe(true);
    expect(await memberIds(roomId)).toEqual([a]);
    expect(signal).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ userId: late }),
    );
    expect(await messagesWithId(messageId)).toHaveLength(1);
    const refused = send(chat, roomId, a);
    await expect(refused).rejects.toBeInstanceOf(ChatPlayerMutedError);
    await expect(refused).rejects.toMatchObject({ data: { reason: 'read_only' } });
  });

  it('refuses an ensure that names another room for the ref, and adds nobody', async () => {
    const { commands, relayAndApply, deliver, relay, takeCommands } = setup();
    const ref = `match:${randomUUID()}`;
    const roomId = randomUUID();
    const [a, b] = [randomUUID(), randomUUID()];
    await commands.ensureRoom({ ref, roomId, name: 'Match', memberIds: [a] });
    await relayAndApply();

    await commands.ensureRoom({ ref, roomId: randomUUID(), name: 'Match', memberIds: [b] });
    await relay.drainOnce();
    const [ensure] = takeCommands();

    await expect(deliver(ensure!)).rejects.toBeInstanceOf(ChatContextRoomIdConflictError);
    expect(await memberIds(roomId)).toEqual([a]);
    expect(await db.drizzle.db.select().from(processedEvents)).toHaveLength(1);
  });

  it('refuses a post whose id names another message', async () => {
    const { commands, relayAndApply, deliver, relay, takeCommands } = setup();
    const [ref, otherRef] = [`match:${randomUUID()}`, `match:${randomUUID()}`];
    const messageId = randomUUID();
    await commands.ensureRoom({ ref, roomId: randomUUID(), name: 'Match', memberIds: [] });
    await commands.ensureRoom({
      ref: otherRef,
      roomId: randomUUID(),
      name: 'Match',
      memberIds: [],
    });
    await commands.postSystemEvent({ ref, messageId, code: 'match.started' });
    await relayAndApply();

    await commands.postSystemEvent({ ref: otherRef, messageId, code: 'match.started' });
    await relay.drainOnce();
    const [post] = takeCommands();

    const refused = deliver(post!);
    await expect(refused).rejects.toBeInstanceOf(ChatSystemCardRefusedError);
    await expect(refused).rejects.toThrow('conflict');
    expect(await db.drizzle.db.select().from(processedEvents)).toHaveLength(3);
  });

  it('refuses a post whose room is deleted while it applies', async () => {
    const { commands, relayAndApply, deliver, relay, takeCommands, rooms } = setup();
    const ref = `match:${randomUUID()}`;
    const roomId = randomUUID();
    const messageId = randomUUID();
    await commands.ensureRoom({ ref, roomId, name: 'Match', memberIds: [] });
    await relayAndApply();
    const findRoom = rooms.findRoom.bind(rooms);
    vi.spyOn(rooms, 'findRoom').mockImplementationOnce(async (r) => {
      const room = await findRoom(r);
      await db.drizzle.db
        .update(chatRoom)
        .set({ deletedAt: new Date() })
        .where(eq(chatRoom.id, roomId));
      return room;
    });

    await commands.postSystemEvent({ ref, messageId, code: 'match.started' });
    await relay.drainOnce();
    const [post] = takeCommands();

    const refused = deliver(post!);
    await expect(refused).rejects.toBeInstanceOf(ChatSystemCardRefusedError);
    await expect(refused).rejects.toThrow('room-gone');
    expect(await messagesWithId(messageId)).toHaveLength(0);
  });

  it('rejects a command that does not parse, without recording it as processed', async () => {
    const { deliver } = setup();

    await expect(
      deliver({
        eventId: randomUUID(),
        topic: TOPIC,
        payload: { op: 'drop_room', ref: 'match:x' },
        occurredAt: new Date().toISOString(),
        schemaVersion: 1,
      }),
    ).rejects.toThrow();
    expect(await db.drizzle.db.select().from(processedEvents)).toHaveLength(0);
  });
});

describe('the local context room commands (real PG)', () => {
  it('names the room and the message by the caller ids, in the caller tx', async () => {
    const { local } = setup();
    const ref = `match:${randomUUID()}`;
    const roomId = randomUUID();
    const messageId = randomUUID();

    await db.drizzle.db.transaction(async (tx) => {
      const ensured = await local.ensureRoom({ ref, roomId, name: 'Match', memberIds: [], tx });
      const posted = await local.postSystemEvent({ ref, messageId, code: 'match.started', tx });
      return [ensured, posted];
    });

    expect(await roomById(roomId)).toMatchObject({ contextRef: ref });
    expect(await messagesWithId(messageId)).toEqual([expect.objectContaining({ roomId })]);
  });
});

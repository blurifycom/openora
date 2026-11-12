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
  type EventBus,
} from '@openora/core/server';
import { migrate as migrateOutbox } from '@openora/core/server/migrate';
import {
  ADMIN_USER_DIRECTORY,
  AUDIT_WRITER,
  CHAT_SYSTEM_AUTHOR_ID,
  GLOBAL_CHAT_ROOM_ID,
  IDENTITY_READER,
  JOB_QUEUE,
  RATE_LIMITER,
  REALTIME_CLIENT_AUTHORIZER,
  REALTIME_TRANSPORT,
  type JobQueueAdapter,
  type AdminUserDirectory,
  type AuditWritePort,
  type BrokerHandler,
  type ChatModeration,
  type CommandMetadata,
  type EventEnvelope,
  type MessageBrokerAdapter,
  type RealtimeTransport,
} from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { makeChatContextSendPolicy, makeIdentityReader, mock } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { chatMessage, chatRoom } from '../schema/index.js';
import { ChatService } from '../service/chat.service.js';
import { ChatSystemCardService } from '../service/chat-system-card.service.js';
import { OutboxChatSystemWriter } from '../service/outbox-chat-system-writer.service.js';
import chatPlugin from '../plugin.js';

let db: TestDb;

// Runs subscribed handlers inline, so one drainOnce() is one full delivery.
function inlineBroker(): MessageBrokerAdapter & { published: EventEnvelope[] } {
  const handlers = new Map<string, BrokerHandler[]>();
  const published: EventEnvelope[] = [];
  return {
    published,
    async publish(envelope) {
      published.push(envelope);
      for (const handler of handlers.get(envelope.topic) ?? []) {
        await handler(envelope);
      }
    },
    subscribe(topic, handler) {
      handlers.set(topic, [...(handlers.get(topic) ?? []), handler]);
      return () => {};
    },
    close: async () => {},
  };
}

function setup() {
  const broker = inlineBroker();
  const bus = createEventBus({
    broker,
    outbox: new DrizzleOutboxWriter(),
    processedEvents: new DrizzleProcessedEventLog(db.drizzle.db),
  });
  const publish = vi.fn();
  const cards = new ChatSystemCardService(db.drizzle, mock<RealtimeTransport>({ publish }));
  const outcomes: string[] = [];
  // The chat plugin's subscription: same topic, deduped per consumer through processed_events.
  bus.on(
    'chat.system_message.upserted',
    async (payload) => {
      outcomes.push(await cards.apply(payload));
    },
    { consumer: 'chat/chat.system_message.upserted' },
  );
  const local = new ChatService({
    drizzle: db.drizzle,
    events: bus,
    transport: mock<RealtimeTransport>(),
    directory: mock<AdminUserDirectory>(),
    audit: mock<AuditWritePort>(),
    moderation: mock<ChatModeration>(),
    identityReader: makeIdentityReader(),
    allowedAttachmentHosts: [],
    contextSendPolicy: makeChatContextSendPolicy(),
  });
  return {
    broker,
    outcomes,
    local,
    publish,
    writer: new OutboxChatSystemWriter(bus, db.drizzle),
    relay: new OutboxRelay(db.drizzle.db, broker),
  };
}

const CARD_TOPIC = 'chat.system_message.upserted';

// publishChatEvent publishes on a later microtask; let it run before asserting nothing went out.
const flushPublishes = () => new Promise((resolve) => setImmediate(resolve));

// The chat plugin wired the way createApp wires it: registered, its router factory run (it
// builds the card service), and its card handler subscribed under its own consumer id.
function bootChatCardHandler(bus: EventBus) {
  const container = new Container<CoreTokenCatalog>();
  container.register(DRIZZLE, () => db.drizzle);
  container.register(EVENT_BUS, () => bus);
  container.register(JOB_QUEUE, () => mock<JobQueueAdapter>({ schedule: async () => {} }));
  container.register(REALTIME_TRANSPORT, () => mock<RealtimeTransport>());
  container.register(REALTIME_CLIENT_AUTHORIZER, () => mock());
  container.register(RATE_LIMITER, () => mock());
  container.register(ADMIN_USER_DIRECTORY, () => mock<AdminUserDirectory>());
  container.register(AUDIT_WRITER, () => mock<AuditWritePort>());
  container.register(IDENTITY_READER, () => makeIdentityReader());
  container.register(ADMIN_GUARD, () => mock());
  const registry = new ModuleRegistryImpl<CoreTokenCatalog>(container);
  registry.setOwner('chat');
  chatPlugin.register(registry);
  registry.routers.getAll().get('chat')?.(container);
  const [subscription] = registry.events.getAll().get(CARD_TOPIC) ?? [];
  if (!subscription) {
    throw new Error('chat plugin registered no card handler');
  }
  bus.on(CARD_TOPIC, subscription.handler, { consumer: subscription.consumer });
  return subscription.handler;
}

function giftCard(status: 'available' | 'claimed', giftId = randomUUID()): CommandMetadata {
  return {
    command: 'gift',
    giftId,
    senderId: randomUUID(),
    senderUsername: 'sender',
    amount: '5',
    currency: 'USDT',
    status,
  };
}

async function createRoom(): Promise<string> {
  const [room] = await db.drizzle.db
    .insert(chatRoom)
    .values({ name: 'room', slug: `room-${randomUUID()}` })
    .returning({ id: chatRoom.id });
  return room!.id;
}

const messagesWithId = (id: string) =>
  db.drizzle.db.select().from(chatMessage).where(eq(chatMessage.id, id));

// drizzle wraps the driver error; the Postgres code sits on it or on its cause.
const isUniqueViolation = (e: unknown): boolean =>
  typeof e === 'object' &&
  e !== null &&
  (('code' in e && e.code === '23505') || ('cause' in e && isUniqueViolation(e.cause)));

const outboxRows = () => db.drizzle.db.select().from(eventOutbox);

beforeAll(async () => {
  db = await createTestDb([migrateOutbox, migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${eventOutbox}, ${processedEvents}, ${chatMessage} RESTART IDENTITY CASCADE`,
  );
});

describe('system cards through the outbox (real PG)', () => {
  it('writes the card as one outbox row on the caller tx, and chat stores it once relayed', async () => {
    const { writer, relay } = setup();
    const roomId = await createRoom();
    const giftId = randomUUID();
    const actorId = randomUUID();

    const returned = await db.drizzle.db.transaction((tx) =>
      writer.postSystemMessage({
        messageId: giftId,
        roomId,
        actorId,
        username: 'sender',
        metadata: giftCard('available', giftId),
        tx,
      }),
    );

    expect(await outboxRows()).toHaveLength(1);
    expect(await messagesWithId(giftId)).toHaveLength(0);
    expect(await relay.drainOnce()).toBe(1);
    const [stored] = await messagesWithId(giftId);
    expect(stored).toMatchObject({
      roomId,
      userId: actorId,
      username: 'sender',
      type: 'system',
      version: 1,
      metadata: returned.metadata,
    });
    expect(returned).toMatchObject({ id: giftId, roomId, actorId, userId: actorId });
  });

  it('keeps one card when the same event is delivered twice or emitted twice', async () => {
    const { writer, relay, broker } = setup();
    const roomId = await createRoom();
    const giftId = randomUUID();
    const post = () =>
      db.drizzle.db.transaction((tx) =>
        writer.postSystemMessage({
          messageId: giftId,
          roomId,
          metadata: giftCard('available', giftId),
          tx,
        }),
      );
    await post();
    await relay.drainOnce();

    await broker.publish(broker.published[0]!);
    await post();
    await relay.drainOnce();

    expect(await messagesWithId(giftId)).toHaveLength(1);
  });

  it('leaves the card at v2 when the update is delivered before the post', async () => {
    const { writer, relay, outcomes, publish } = setup();
    const roomId = await createRoom();
    const giftId = randomUUID();
    const actorId = randomUUID();
    const claimed = giftCard('claimed', giftId);
    await db.drizzle.db.transaction((tx) =>
      writer.updateSystemMessage({
        messageId: giftId,
        roomId,
        actorId,
        username: 'sender',
        metadata: claimed,
        tx,
      }),
    );
    await db.drizzle.db.transaction((tx) =>
      writer.postSystemMessage({
        messageId: giftId,
        roomId,
        actorId,
        username: 'sender',
        metadata: giftCard('available', giftId),
        tx,
      }),
    );

    await relay.drainOnce();

    const [stored] = await messagesWithId(giftId);
    expect(stored).toMatchObject({ version: 2, metadata: claimed, userId: actorId });
    expect(outcomes).toEqual(['inserted', 'stale']);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
  });

  it('moves a player-authored card from v1 to v2 in order, the update on its own tx', async () => {
    const { writer, relay, outcomes, publish } = setup();
    const roomId = await createRoom();
    const giftId = randomUUID();
    const senderId = randomUUID();
    const claimed = giftCard('claimed', giftId);
    await db.drizzle.db.transaction(async (tx) => {
      await writer.postSystemMessage({
        messageId: giftId,
        roomId,
        actorId: senderId,
        username: 'sender',
        metadata: giftCard('available', giftId),
        tx,
      });
    });
    await relay.drainOnce();
    await writer.updateSystemMessage({
      messageId: giftId,
      roomId,
      actorId: senderId,
      username: 'sender',
      metadata: claimed,
    });
    await relay.drainOnce();

    const [stored] = await messagesWithId(giftId);
    expect(outcomes).toEqual(['inserted', 'updated']);
    expect(stored).toMatchObject({ version: 2, metadata: claimed, userId: senderId });
    // Once per stored version, after the chat side stored it.
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(2));
    expect(publish).toHaveBeenLastCalledWith(
      `chat:room:${roomId}`,
      expect.objectContaining({ id: giftId, metadata: claimed, type: 'system' }),
    );
  });

  it('drops a card whose room was deleted or soft-deleted, and acknowledges the event', async () => {
    const { writer, relay, outcomes, publish } = setup();
    const gone = await createRoom();
    const closed = await createRoom();
    const goneCard = randomUUID();
    const closedCard = randomUUID();
    await db.drizzle.db.transaction(async (tx) => {
      await writer.postSystemMessage({
        messageId: goneCard,
        roomId: gone,
        metadata: giftCard('available'),
        tx,
      });
      await writer.postSystemMessage({
        messageId: closedCard,
        roomId: closed,
        metadata: giftCard('available'),
        tx,
      });
    });
    await db.drizzle.db.delete(chatRoom).where(eq(chatRoom.id, gone));
    await db.drizzle.db
      .update(chatRoom)
      .set({ deletedAt: new Date() })
      .where(eq(chatRoom.id, closed));

    expect(await relay.drainOnce()).toBe(2);

    expect(await messagesWithId(goneCard)).toHaveLength(0);
    expect(await messagesWithId(closedCard)).toHaveLength(0);
    expect(outcomes).toEqual(['room-gone', 'room-gone']);
    await flushPublishes();
    expect(publish).not.toHaveBeenCalled();
    expect(await db.drizzle.db.select().from(processedEvents)).toHaveLength(2);
  });

  it('stores a card addressed to the global room by its id under the null room', async () => {
    const { writer, relay } = setup();
    const [global] = await db.drizzle.db
      .select({ id: chatRoom.id })
      .from(chatRoom)
      .where(eq(chatRoom.slug, GLOBAL_CHAT_ROOM_ID));
    const messageId = randomUUID();
    await db.drizzle.db.transaction((tx) =>
      writer.postSystemMessage({
        messageId,
        roomId: global!.id,
        metadata: giftCard('available'),
        tx,
      }),
    );

    await relay.drainOnce();

    expect((await messagesWithId(messageId))[0]?.roomId).toBeNull();
  });

  it('leaves no outbox row and no card when the caller tx rolls back', async () => {
    const { writer, relay, broker } = setup();
    const roomId = await createRoom();
    const giftId = randomUUID();

    await expect(
      db.drizzle.db.transaction(async (tx) => {
        await writer.postSystemMessage({
          messageId: giftId,
          roomId,
          metadata: giftCard('available', giftId),
          tx,
        });
        throw new Error('debit refused');
      }),
    ).rejects.toThrow('debit refused');

    expect(await outboxRows()).toHaveLength(0);
    expect(await relay.drainOnce()).toBe(0);
    expect(broker.published).toHaveLength(0);
    expect(await messagesWithId(giftId)).toHaveLength(0);
  });

  it('refuses a card whose id names a message in another room, leaving that message intact', async () => {
    const { writer, relay, outcomes, publish } = setup();
    const ownRoom = await createRoom();
    const otherRoom = await createRoom();
    const [existing] = await db.drizzle.db
      .insert(chatMessage)
      .values({ roomId: otherRoom, userId: randomUUID(), username: 'victim', content: 'hello' })
      .returning();
    await db.drizzle.db.transaction((tx) =>
      writer.updateSystemMessage({
        messageId: existing!.id,
        roomId: ownRoom,
        actorId: CHAT_SYSTEM_AUTHOR_ID,
        metadata: giftCard('claimed'),
        tx,
      }),
    );

    await relay.drainOnce();

    expect(outcomes).toEqual(['conflict']);
    await flushPublishes();
    expect(publish).not.toHaveBeenCalled();
    expect(await messagesWithId(existing!.id)).toEqual([existing]);
  });

  it('refuses a local post whose caller id names a message in another room', async () => {
    const { local } = setup();
    const otherRoom = await createRoom();
    const [existing] = await db.drizzle.db
      .insert(chatMessage)
      .values({ roomId: otherRoom, userId: randomUUID(), username: 'victim', content: 'hello' })
      .returning();
    const ownRoom = await createRoom();

    await expect(
      db.drizzle.db.transaction((tx) =>
        local.postSystemMessage({
          messageId: existing!.id,
          roomId: ownRoom,
          metadata: giftCard('available'),
          tx,
        }),
      ),
    ).rejects.toSatisfy(isUniqueViolation);

    expect(await messagesWithId(existing!.id)).toEqual([existing]);
  });

  it('refuses a local update whose id names a player message, leaving it intact', async () => {
    const { local } = setup();
    const roomId = await createRoom();
    const [existing] = await db.drizzle.db
      .insert(chatMessage)
      .values({ roomId, userId: randomUUID(), username: 'victim', content: 'hello' })
      .returning();

    await expect(
      db.drizzle.db.transaction((tx) =>
        local.updateSystemMessage({
          messageId: existing!.id,
          roomId,
          actorId: existing!.userId,
          metadata: giftCard('claimed'),
          tx,
        }),
      ),
    ).rejects.toThrow('not found');

    expect(await messagesWithId(existing!.id)).toEqual([existing]);
  });

  it('keys a local card on the caller id and moves it to v2 on update', async () => {
    const { local } = setup();
    const roomId = await createRoom();
    const giftId = randomUUID();
    const claimed = giftCard('claimed', giftId);

    const posted = await db.drizzle.db.transaction((tx) =>
      local.postSystemMessage({
        messageId: giftId,
        roomId,
        metadata: giftCard('available', giftId),
        tx,
      }),
    );
    await db.drizzle.db.transaction((tx) =>
      local.updateSystemMessage({
        messageId: giftId,
        roomId,
        actorId: CHAT_SYSTEM_AUTHOR_ID,
        metadata: claimed,
        tx,
      }),
    );

    expect(posted.id).toBe(giftId);
    expect((await messagesWithId(giftId))[0]).toMatchObject({ version: 2, metadata: claimed });
  });
});

describe('the chat plugin card handler (real PG)', () => {
  function bootPlugin() {
    const broker = inlineBroker();
    const bus = createEventBus({
      broker,
      outbox: new DrizzleOutboxWriter(),
      processedEvents: new DrizzleProcessedEventLog(db.drizzle.db),
    });
    return {
      handler: bootChatCardHandler(bus),
      writer: new OutboxChatSystemWriter(bus, db.drizzle),
      relay: new OutboxRelay(db.drizzle.db, broker),
    };
  }

  const acknowledged = () => db.drizzle.db.select().from(processedEvents);

  it('stores a parsed card, and acknowledges a refused id and a gone room without writing', async () => {
    const { writer, relay } = bootPlugin();
    const roomId = await createRoom();
    const goneRoom = await createRoom();
    const [playerMessage] = await db.drizzle.db
      .insert(chatMessage)
      .values({ roomId, userId: randomUUID(), username: 'victim', content: 'hello' })
      .returning();
    const giftId = randomUUID();
    const goneCard = randomUUID();
    await db.drizzle.db.transaction(async (tx) => {
      await writer.postSystemMessage({
        messageId: giftId,
        roomId,
        metadata: giftCard('available', giftId),
        tx,
      });
      await writer.updateSystemMessage({
        messageId: playerMessage!.id,
        roomId,
        actorId: playerMessage!.userId,
        metadata: giftCard('claimed'),
        tx,
      });
      await writer.postSystemMessage({
        messageId: goneCard,
        roomId: goneRoom,
        metadata: giftCard('available'),
        tx,
      });
    });
    await db.drizzle.db.delete(chatRoom).where(eq(chatRoom.id, goneRoom));

    expect(await relay.drainOnce()).toBe(3);

    expect((await messagesWithId(giftId))[0]).toMatchObject({ type: 'system', version: 1 });
    expect(await messagesWithId(playerMessage!.id)).toEqual([playerMessage]);
    expect(await messagesWithId(goneCard)).toHaveLength(0);
    expect(await acknowledged()).toHaveLength(3);
  });

  it('rejects a payload that does not parse, so it is not acknowledged', async () => {
    const { handler } = bootPlugin();

    await expect(handler({ messageId: 'not-a-uuid', roomId: null, version: 0 })).rejects.toThrow();
    expect(await acknowledged()).toHaveLength(0);
  });
});

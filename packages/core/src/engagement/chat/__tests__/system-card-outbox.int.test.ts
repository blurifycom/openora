import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import {
  DrizzleOutboxWriter,
  DrizzleProcessedEventLog,
  OutboxRelay,
  createEventBus,
  eventOutbox,
  processedEvents,
} from '@openora/core/server';
import { migrate as migrateOutbox } from '@openora/core/server/migrate';
import {
  GLOBAL_CHAT_ROOM_ID,
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
  const cards = new ChatSystemCardService(db.drizzle);
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
    writer: new OutboxChatSystemWriter(bus),
    relay: new OutboxRelay(db.drizzle.db, broker),
  };
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
    const { writer, relay, outcomes } = setup();
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
  });

  it('moves the card from v1 to v2 when they arrive in order', async () => {
    const { writer, relay } = setup();
    const roomId = await createRoom();
    const giftId = randomUUID();
    const claimed = giftCard('claimed', giftId);
    await db.drizzle.db.transaction(async (tx) => {
      await writer.postSystemMessage({
        messageId: giftId,
        roomId,
        metadata: giftCard('available', giftId),
        tx,
      });
    });
    await relay.drainOnce();
    await db.drizzle.db.transaction((tx) =>
      writer.updateSystemMessage({ messageId: giftId, roomId, metadata: claimed, tx }),
    );
    await relay.drainOnce();

    const [stored] = await messagesWithId(giftId);
    expect(stored).toMatchObject({ version: 2, metadata: claimed });
  });

  it('drops a card whose room was deleted or soft-deleted, and acknowledges the event', async () => {
    const { writer, relay, outcomes } = setup();
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
    const { writer, relay, outcomes } = setup();
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
        metadata: giftCard('claimed'),
        tx,
      }),
    );

    await relay.drainOnce();

    expect(outcomes).toEqual(['conflict']);
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
    ).rejects.toThrow();

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
      local.updateSystemMessage({ messageId: giftId, metadata: claimed, tx }),
    );

    expect(posted.id).toBe(giftId);
    expect((await messagesWithId(giftId))[0]).toMatchObject({ version: 2, metadata: claimed });
  });
});

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import {
  ADMIN_GUARD,
  Container,
  DRIZZLE,
  DrizzleOutboxWriter,
  DrizzleProcessedEventLog,
  EVENT_BUS,
  ModuleRegistryImpl,
  OutboxRelay,
  createEventBus,
  eventOutbox,
  processedEvents,
  type AdminGuard,
  type CoreTokenCatalog,
  type EventBus,
} from '@openora/core/server';
import { migrate as migrateOutbox } from '@openora/core/server/migrate';
import {
  IDENTITY_READER,
  type AdminUserDirectory,
  type AuditWritePort,
  type ChatModeration,
  type BrokerHandler,
  type EventEnvelope,
  type FriendshipDissolvedPayload,
  type IdentityReader,
  type MessageBrokerAdapter,
  type OutboxWriter,
  type RealtimeTransport,
  type SocialCommands,
} from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { auditLog } from '@openora/core/audit/schema';
import { migrate as migrateAudit } from '@openora/core/audit/migrate';
import auditPlugin from '@openora/core/audit/server';
import {
  NO_CLIENT_META,
  makeChatContextSendPolicy,
  makeIdentityReader,
  mock,
} from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { chatUserBlock, chatUserIgnore } from '../schema/index.js';
import { ChatService } from '../service/chat.service.js';

let db: TestDb;

// In-process broker: the relay publishes into it and it runs the subscribed handlers
// inline, so one drainOnce() is one full delivery with no timing in the test.
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

// The audit plugin wired the way createApp wires it: registered, its router factory run
// (it builds the writer), and each handler subscribed under its stable consumer id.
function subscribeAudit(bus: EventBus, identityReader: IdentityReader): void {
  const container = new Container<CoreTokenCatalog>();
  container.register(DRIZZLE, () => db.drizzle);
  container.register(EVENT_BUS, () => bus);
  container.register(IDENTITY_READER, () => identityReader);
  container.register(ADMIN_GUARD, () => mock<AdminGuard>());
  const registry = new ModuleRegistryImpl<CoreTokenCatalog>(container);
  registry.setOwner('audit');
  auditPlugin.register(registry);
  registry.routers.getAll().get('audit')?.(container);
  for (const [topic, handlers] of registry.events.getAll()) {
    for (const { handler, consumer } of handlers) {
      bus.on(topic, handler, { consumer });
    }
  }
}

// The real outbox writer; with `failOn`, it writes that topic's row and then throws, so
// the caller's transaction has to roll the row back with everything else.
function outboxWriter(failOn?: string): OutboxWriter {
  const writer = new DrizzleOutboxWriter();
  return {
    async write(tx, envelope) {
      await writer.write(tx, envelope);
      if (envelope.topic === failOn) {
        throw new Error('outbox write failed');
      }
    },
  };
}

function setup({
  socialCommands,
  failOutboxOn,
}: { socialCommands?: SocialCommands; failOutboxOn?: string } = {}) {
  const broker = inlineBroker();
  const bus = createEventBus({
    broker,
    outbox: outboxWriter(failOutboxOn),
    processedEvents: new DrizzleProcessedEventLog(db.drizzle.db),
  });
  const playerIds = new Map<string, string>();
  const identityReader: IdentityReader = {
    ...makeIdentityReader(),
    getPlayerIdByUserIdSafe: async (userId) => playerIds.get(userId) ?? null,
  };
  const svc = new ChatService({
    drizzle: db.drizzle,
    events: bus,
    transport: mock<RealtimeTransport>(),
    directory: mock<AdminUserDirectory>(),
    audit: mock<AuditWritePort>(),
    moderation: mock<ChatModeration>(),
    identityReader,
    allowedAttachmentHosts: [],
    socialCommands,
    contextSendPolicy: makeChatContextSendPolicy(),
  });
  const player = (): string => {
    const userId = randomUUID();
    playerIds.set(userId, randomUUID());
    return userId;
  };
  return {
    svc,
    bus,
    broker,
    identityReader,
    player,
    playerIdOf: (userId: string) => playerIds.get(userId) ?? null,
    relay: new OutboxRelay(db.drizzle.db, broker),
  };
}

const outboxRows = () => db.drizzle.db.select().from(eventOutbox);

const auditRowsFor = (action: string, resourceId: string | null) =>
  db.drizzle.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.resourceId, resourceId ?? '')));

beforeAll(async () => {
  db = await createTestDb([migrateOutbox, migrateAudit, migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${eventOutbox}, ${processedEvents}, ${chatUserBlock}, ${chatUserIgnore} RESTART IDENTITY CASCADE`,
  );
});

describe('block and ignore events go through the outbox (real PG)', () => {
  it('writes exactly one outbox row carrying the block payload when the block commits', async () => {
    const { svc, player, playerIdOf } = setup();
    const blockerId = player();
    const blockedId = player();

    await svc.blockUser(blockerId, blockedId, { ip: '203.0.113.7', userAgent: 'test-agent' });

    const rows = await outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      topic: 'chat.user.blocked',
      publishedAt: null,
      payload: {
        blockerId,
        actorPlayerId: playerIdOf(blockerId),
        blockedId,
        playerId: playerIdOf(blockedId),
        ip: '203.0.113.7',
        userAgent: 'test-agent',
      },
    });
  });

  it('leaves no outbox row and no block when the block transaction rolls back', async () => {
    const dissolveFriendshipOnBlock = async () => {
      throw new Error('social port down');
    };
    const { svc, player, broker, relay } = setup({
      socialCommands: mock<SocialCommands>({ dissolveFriendshipOnBlock }),
    });

    await expect(svc.blockUser(player(), player(), NO_CLIENT_META)).rejects.toThrow(
      'social port down',
    );

    expect(await outboxRows()).toHaveLength(0);
    expect(await db.drizzle.db.select().from(chatUserBlock)).toHaveLength(0);
    expect(await relay.drainOnce()).toBe(0);
    expect(broker.published).toHaveLength(0);
  });

  it('rolls the block back when its outbox write fails', async () => {
    const { svc, player } = setup({ failOutboxOn: 'chat.user.blocked' });

    await expect(svc.blockUser(player(), player(), NO_CLIENT_META)).rejects.toThrow(
      'outbox write failed',
    );

    expect(await outboxRows()).toHaveLength(0);
    expect(await db.drizzle.db.select().from(chatUserBlock)).toHaveLength(0);
  });

  it('writes one block row and one event for two concurrent blocks of the same pair', async () => {
    const { svc, player } = setup();
    const blockerId = player();
    const blockedId = player();

    await Promise.all([
      svc.blockUser(blockerId, blockedId, NO_CLIENT_META),
      svc.blockUser(blockerId, blockedId, NO_CLIENT_META),
    ]);

    expect(await db.drizzle.db.select().from(chatUserBlock)).toHaveLength(1);
    expect((await outboxRows()).map((r) => r.topic)).toEqual(['chat.user.blocked']);
  });

  it('writes one ignore row and one event for two concurrent ignores of the same pair', async () => {
    const { svc, player } = setup();
    const ignorerId = player();
    const ignoredId = player();

    await Promise.all([
      svc.ignoreUser(ignorerId, ignoredId, NO_CLIENT_META),
      svc.ignoreUser(ignorerId, ignoredId, NO_CLIENT_META),
    ]);

    expect(await db.drizzle.db.select().from(chatUserIgnore)).toHaveLength(1);
    expect((await outboxRows()).map((r) => r.topic)).toEqual(['chat.user.ignored']);
  });

  it('writes no outbox row for a re-block or an unblock of a pair that is not blocked', async () => {
    const { svc, player } = setup();
    const blockerId = player();
    const blockedId = player();
    await svc.blockUser(blockerId, blockedId, NO_CLIENT_META);

    await svc.blockUser(blockerId, blockedId, NO_CLIENT_META);
    await svc.unblockUser(blockerId, player(), NO_CLIENT_META);

    expect((await outboxRows()).map((r) => r.topic)).toEqual(['chat.user.blocked']);
  });

  it('writes one unblock row, and none for a second unblock', async () => {
    const { svc, player } = setup();
    const blockerId = player();
    const blockedId = player();
    await svc.blockUser(blockerId, blockedId, NO_CLIENT_META);

    await svc.unblockUser(blockerId, blockedId, NO_CLIENT_META);
    await svc.unblockUser(blockerId, blockedId, NO_CLIENT_META);

    expect((await outboxRows()).map((r) => r.topic).sort()).toEqual([
      'chat.user.blocked',
      'chat.user.unblocked',
    ]);
  });

  it('writes one ignore and one unignore row, none for the repeated no-ops', async () => {
    const { svc, player } = setup();
    const ignorerId = player();
    const ignoredId = player();

    await svc.ignoreUser(ignorerId, ignoredId, NO_CLIENT_META);
    await svc.ignoreUser(ignorerId, ignoredId, NO_CLIENT_META);
    await svc.unignoreUser(ignorerId, ignoredId, NO_CLIENT_META);
    await svc.unignoreUser(ignorerId, ignoredId, NO_CLIENT_META);

    expect((await outboxRows()).map((r) => r.topic).sort()).toEqual([
      'chat.user.ignored',
      'chat.user.unignored',
    ]);
  });

  it('writes the friendship the block dissolved as one durable event on the block transaction', async () => {
    const blockerId = randomUUID();
    const dissolved: FriendshipDissolvedPayload = {
      friendshipId: randomUUID(),
      actorId: blockerId,
      actorPlayerId: randomUUID(),
      otherUserId: randomUUID(),
      reason: 'blocked',
    };
    const { svc } = setup({
      socialCommands: mock<SocialCommands>({ dissolveFriendshipOnBlock: async () => dissolved }),
    });

    await svc.blockUser(blockerId, dissolved.otherUserId, NO_CLIENT_META);

    const removed = (await outboxRows()).filter((r) => r.topic === 'social.friendship.removed');
    expect(removed).toHaveLength(1);
    expect(removed[0]?.payload).toEqual(dissolved);
  });

  it('gives audit exactly one row per block, also when the broker redelivers the event', async () => {
    const { svc, bus, broker, identityReader, player, playerIdOf, relay } = setup();
    subscribeAudit(bus, identityReader);
    const blockerId = player();
    const blockedId = player();
    await svc.blockUser(blockerId, blockedId, NO_CLIENT_META);

    expect(await relay.drainOnce()).toBe(1);
    expect(await relay.drainOnce()).toBe(0);
    const [delivered] = broker.published;
    expect(delivered).toBeDefined();
    await broker.publish(delivered!);

    const rows = await auditRowsFor('chat.user.blocked', playerIdOf(blockedId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorType: 'player', actorId: playerIdOf(blockerId) });
  });
});

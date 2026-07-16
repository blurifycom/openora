import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type { EventBus } from '@openora/core/server';
import { InProcessRealtimeTransport, createTestDb, type TestDb } from '@openora/core/testing';
import { migrate as migrateIdentity } from '@openora/core/pam/migrate/identity';
import { migrate as migrateChat } from '@openora/core/engagement/migrate/chat';
import { user } from '@openora/core/pam/schema/identity';
import type { ChatMessage } from '../contract/index.js';
import { mock, mockDb } from '../../../testing/mock.js';
import { chatMessage, chatRoom, chatUserBlock } from '../schema/index.js';
import {
  ChatService,
  chatChannel,
  ChatRoomNotFoundError,
  ChatMessageNotFoundError,
  ChatMessageOwnershipError,
  ChatMessageBlockedError,
  ChatSelfBlockError,
} from '../service/chat.service.js';

const noEvents = () => mock<EventBus>({ emit: () => undefined });

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb([migrateIdentity, migrateChat]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${chatMessage}, ${chatUserBlock}, ${chatRoom}, ${user} RESTART IDENTITY CASCADE`,
  );
});

async function seedUser(name: string, role = 'player') {
  const [row] = await db.drizzle.db
    .insert(user)
    .values({ name, email: `${randomUUID()}@x.dev`, role })
    .returning();
  return row;
}

describe('ChatService domain errors', () => {
  it('ChatRoomNotFoundError carries the id', () => {
    const err = new ChatRoomNotFoundError('room-123');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ChatRoomNotFoundError');
    expect(err.message).toContain('room-123');
  });

  it('ChatMessageNotFoundError carries the id', () => {
    const err = new ChatMessageNotFoundError('msg-456');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ChatMessageNotFoundError');
    expect(err.message).toContain('msg-456');
  });

  it('ChatMessageOwnershipError carries the id', () => {
    const err = new ChatMessageOwnershipError('msg-789');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ChatMessageOwnershipError');
    expect(err.message).toContain('msg-789');
  });
});

describe('ChatService realtime wiring', () => {
  const sample: ChatMessage = {
    id: 'm1',
    roomId: 'r1',
    userId: 'u1',
    username: 'alice',
    content: 'hi',
    isDeleted: false,
    createdAt: '2026-05-29T00:00:00.000Z',
  };

  it('maps room vs global channels', () => {
    expect(chatChannel(null)).toBe('chat:global');
    expect(chatChannel('r1')).toBe('chat:room:r1');
  });

  // Realtime push stays on the InProcess transport double - it is the designated test
  // double for the unbound-in-prod REALTIME_TRANSPORT seam (no DB involved here).
  it('delivers messages published on a room channel to subscribers, then stops on unsubscribe', () => {
    const transport = new InProcessRealtimeTransport();
    const service = new ChatService(mockDb({}), noEvents(), transport);

    const got: ChatMessage[] = [];
    const unsub = service.subscribeMessages('r1', (m) => got.push(m));

    transport.publish(chatChannel('r1'), sample);
    expect(got).toEqual([sample]);

    transport.publish(chatChannel(null), { ...sample, roomId: null }); // global, not r1
    expect(got).toHaveLength(1);

    unsub();
    transport.publish(chatChannel('r1'), sample);
    expect(got).toHaveLength(1);
  });
});

describe('ChatService.subscribeMessages per-viewer block filtering (AC11, real SQL)', () => {
  function sampleFrom(userId: string): ChatMessage {
    return {
      id: randomUUID(),
      roomId: null,
      userId,
      username: 'someone',
      content: 'hi',
      isDeleted: false,
      createdAt: '2026-05-29T00:00:00.000Z',
    };
  }

  it('hides messages from blocked senders for the viewer, delivers the rest', async () => {
    const viewerId = randomUUID();
    const blockedId = randomUUID();
    const otherId = randomUUID();
    await db.drizzle.db.insert(chatUserBlock).values({ blockerId: viewerId, blockedId });

    const transport = new InProcessRealtimeTransport();
    const service = new ChatService(db.drizzle, noEvents(), transport);

    const got: ChatMessage[] = [];
    service.subscribeMessages(null, (m) => got.push(m), viewerId);

    transport.publish(chatChannel(null), sampleFrom(blockedId));
    transport.publish(chatChannel(null), sampleFrom(otherId));

    await waitFor(() => got.length >= 1);
    expect(got.map((m) => m.userId)).toEqual([otherId]);
  });

  it('buffers messages that arrive before the block set loads, then filters on flush', async () => {
    const viewerId = randomUUID();
    const blockedId = randomUUID();
    const otherId = randomUUID();
    await db.drizzle.db.insert(chatUserBlock).values({ blockerId: viewerId, blockedId });

    const transport = new InProcessRealtimeTransport();
    const service = new ChatService(db.drizzle, noEvents(), transport);

    const got: ChatMessage[] = [];
    service.subscribeMessages(null, (m) => got.push(m), viewerId);

    // Published synchronously, before the async block-set query resolves.
    transport.publish(chatChannel(null), sampleFrom(blockedId));
    transport.publish(chatChannel(null), sampleFrom(otherId));
    expect(got).toHaveLength(0);

    await waitFor(() => got.length >= 1);
    expect(got.map((m) => m.userId)).toEqual([otherId]);
  });

  // The fail-open branch is an error-handling path; a failing DB double is the honest
  // way to force the block-set load to reject (a healthy real DB never does).
  it('fails open (delivers all) when the block-list load rejects', async () => {
    const transport = new InProcessRealtimeTransport();
    const failingDb = mockDb({
      select: () => ({
        from: () => ({
          where: async () => {
            throw new Error('db down');
          },
        }),
      }),
    });
    const service = new ChatService(failingDb, noEvents(), transport);

    const got: ChatMessage[] = [];
    service.subscribeMessages(null, (m) => got.push(m), randomUUID());

    transport.publish(chatChannel(null), sampleFrom(randomUUID()));
    await waitFor(() => got.length >= 1);
    expect(got).toHaveLength(1);
  });
});

describe('ChatService.sendGlobalMessage username resolution (real SQL)', () => {
  it('stores the display name from the verified user, ignoring the header-derived fallback', async () => {
    const u = await seedUser('Platform Admin', 'admin');
    const service = new ChatService(db.drizzle, noEvents(), new InProcessRealtimeTransport());

    const msg = await service.sendGlobalMessage(u.id, 'spoofed-header-name', 'hi');
    expect(msg.username).toBe('Platform Admin');

    const [stored] = await db.drizzle.db.select().from(chatMessage);
    expect(stored.username).toBe('Platform Admin');
    expect(stored.userId).toBe(u.id);
  });

  it('falls back to the passed name, then anonymous, when the user row is missing', async () => {
    const service = new ChatService(db.drizzle, noEvents(), new InProcessRealtimeTransport());
    expect((await service.sendGlobalMessage(randomUUID(), 'fallback', 'hi')).username).toBe(
      'fallback',
    );
    expect((await service.sendGlobalMessage(randomUUID(), '', 'hi')).username).toBe('anonymous');
  });

  it('blocks profane messages before they are stored or published (AC8)', async () => {
    const u = await seedUser('Alice');
    const transport = new InProcessRealtimeTransport();
    const delivered: ChatMessage[] = [];
    transport.subscribe<ChatMessage>('chat:global', (m) => delivered.push(m));
    const service = new ChatService(db.drizzle, noEvents(), transport);

    await expect(service.sendGlobalMessage(u.id, 'Alice', 'this is shit')).rejects.toThrow(
      ChatMessageBlockedError,
    );
    expect(delivered).toHaveLength(0);
    expect(await db.drizzle.db.select().from(chatMessage)).toHaveLength(0);
  });

  it('persists URL-sanitized content (AC7)', async () => {
    const u = await seedUser('Alice');
    const service = new ChatService(db.drizzle, noEvents(), new InProcessRealtimeTransport());
    const msg = await service.sendGlobalMessage(u.id, 'Alice', 'click javascript:alert(1)');
    expect(msg.content).toBe('click javascript alert(1)');

    const [stored] = await db.drizzle.db.select().from(chatMessage);
    expect(stored.content).toBe('click javascript alert(1)');
  });
});

describe('ChatService.blockUser', () => {
  it('rejects blocking yourself', async () => {
    const service = new ChatService(mockDb({}), noEvents(), new InProcessRealtimeTransport());
    await expect(service.blockUser('u1', 'u1')).rejects.toThrow(ChatSelfBlockError);
  });
});

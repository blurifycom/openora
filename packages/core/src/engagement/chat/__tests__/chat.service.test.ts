import { describe, it, expect } from 'vitest';
import { InProcessRealtimeTransport, type EventBus } from '@openora/core/server';
import type { ChatMessage } from '../contract/index.js';
import { mock, mockDb } from '../../../testing/mock.js';
import {
  ChatService,
  chatChannel,
  ChatRoomNotFoundError,
  ChatMessageNotFoundError,
  ChatMessageOwnershipError,
  ChatMessageBlockedError,
  ChatSelfBlockError,
} from '../service/chat.service.js';

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

  it('delivers messages published on a room channel to subscribers, then stops on unsubscribe', () => {
    const transport = new InProcessRealtimeTransport();
    const service = new ChatService(
      mockDb({}),
      mock<EventBus>({ emit: () => undefined }),
      transport,
    );

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

describe('ChatService.subscribeMessages per-viewer block filtering (AC11)', () => {
  const sample: ChatMessage = {
    id: 'm1',
    roomId: null,
    userId: 'sender',
    username: 'alice',
    content: 'hi',
    isDeleted: false,
    createdAt: '2026-05-29T00:00:00.000Z',
  };

  // Mocks only the `blockedIdsFor` query: select({ blockedId }).from().where().
  function blockListDb(blockedIds: string[]) {
    return mockDb({
      select: () => ({
        from: () => ({ where: async () => blockedIds.map((id) => ({ blockedId: id })) }),
      }),
    });
  }

  // Drain the microtask queue so the async block-set load resolves and flushes.
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('hides messages from blocked senders for the viewer, delivers the rest', async () => {
    const transport = new InProcessRealtimeTransport();
    const service = new ChatService(
      blockListDb(['blocked-user']),
      mock<EventBus>({ emit: () => undefined }),
      transport,
    );

    const got: ChatMessage[] = [];
    service.subscribeMessages(null, (m) => got.push(m), 'viewer-1');
    await flush();

    transport.publish(chatChannel(null), { ...sample, userId: 'blocked-user' });
    transport.publish(chatChannel(null), { ...sample, userId: 'other-user' });
    expect(got.map((m) => m.userId)).toEqual(['other-user']);
  });

  it('buffers messages that arrive before the block set loads, then filters on flush', async () => {
    const transport = new InProcessRealtimeTransport();
    const service = new ChatService(
      blockListDb(['blocked-user']),
      mock<EventBus>({ emit: () => undefined }),
      transport,
    );

    const got: ChatMessage[] = [];
    service.subscribeMessages(null, (m) => got.push(m), 'viewer-1');

    // Published synchronously, before the async block-set load resolves.
    transport.publish(chatChannel(null), { ...sample, userId: 'blocked-user' });
    transport.publish(chatChannel(null), { ...sample, userId: 'other-user' });
    expect(got).toHaveLength(0);

    await flush();
    expect(got.map((m) => m.userId)).toEqual(['other-user']);
  });

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
    const service = new ChatService(
      failingDb,
      mock<EventBus>({ emit: () => undefined }),
      transport,
    );

    const got: ChatMessage[] = [];
    service.subscribeMessages(null, (m) => got.push(m), 'viewer-1');
    await flush();

    transport.publish(chatChannel(null), { ...sample, userId: 'anyone' });
    expect(got).toHaveLength(1);
  });
});

describe('ChatService.sendGlobalMessage username resolution', () => {
  function makeDb(userName: string | null) {
    return {
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => (userName ? [{ name: userName }] : []) }),
        }),
      }),
      insert: () => ({
        values: (v: { userId: string; username: string; content: string }) => ({
          returning: async () => [
            {
              id: 'm1',
              roomId: null,
              userId: v.userId,
              username: v.username,
              content: v.content,
              isDeleted: false,
              createdAt: new Date('2026-06-01T00:00:00.000Z'),
            },
          ],
        }),
      }),
    };
  }

  it('stores the display name from the verified user, ignoring the header-derived fallback', async () => {
    const transport = new InProcessRealtimeTransport();
    const service = new ChatService(
      mockDb(makeDb('Platform Admin')),
      mock<EventBus>({ emit: () => undefined }),
      transport,
    );

    const msg = await service.sendGlobalMessage('u1', 'spoofed-header-name', 'hi');
    expect(msg.username).toBe('Platform Admin');
  });

  it('falls back to the passed name, then anonymous, when the user row is missing', async () => {
    const service = new ChatService(
      mockDb(makeDb(null)),
      mock<EventBus>({ emit: () => undefined }),
      new InProcessRealtimeTransport(),
    );
    expect((await service.sendGlobalMessage('u1', 'fallback', 'hi')).username).toBe('fallback');
    expect((await service.sendGlobalMessage('u1', '', 'hi')).username).toBe('anonymous');
  });

  it('blocks profane messages before they are stored or published (AC8)', async () => {
    const transport = new InProcessRealtimeTransport();
    const delivered: ChatMessage[] = [];
    transport.subscribe<ChatMessage>('chat:global', (m) => delivered.push(m));
    const service = new ChatService(
      mockDb(makeDb('Alice')),
      mock<EventBus>({ emit: () => undefined }),
      transport,
    );

    await expect(service.sendGlobalMessage('u1', 'Alice', 'this is shit')).rejects.toThrow(
      ChatMessageBlockedError,
    );
    expect(delivered).toHaveLength(0);
  });

  it('persists URL-sanitized content (AC7)', async () => {
    const service = new ChatService(
      mockDb(makeDb('Alice')),
      mock<EventBus>({ emit: () => undefined }),
      new InProcessRealtimeTransport(),
    );
    const msg = await service.sendGlobalMessage('u1', 'Alice', 'click javascript:alert(1)');
    expect(msg.content).toBe('click javascript alert(1)');
  });
});

describe('ChatService.blockUser', () => {
  it('rejects blocking yourself', async () => {
    const service = new ChatService(
      mockDb({}),
      mock<EventBus>({ emit: () => undefined }),
      new InProcessRealtimeTransport(),
    );
    await expect(service.blockUser('u1', 'u1')).rejects.toThrow(ChatSelfBlockError);
  });
});

import { type EventBus, type DrizzleService } from '@openora/core/server';
import { CHAT_ROOM_CATEGORIES, type ChatMessage } from '../contract/index.js';
import { mock, mockDb, makeDrizzle, makeEvents, readPrivate } from '../../../testing/mock.js';
import { describe, it, expect, vi } from 'vitest';
import {
  ChatService,
  chatChannel,
  ChatRoomNotFoundError,
  ChatMessageNotFoundError,
  ChatMessageOwnershipError,
  ChatMessageBlockedError,
  ChatSelfBlockError,
  ChatRoomSlugConflictError,
  ChatRoomJoinCodeNotFoundError,
  ChatRoomBannedError,
  ChatRoomLimitReachedError,
  ChatRoomNotMemberError,
  ChatRoomNotModeratorError,
  ChatRoomSelfModerationError,
} from '../service/chat.service.js';
import { InProcessRealtimeTransport } from '@openora/core/testing';

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

  it('ChatMessageOwnershipError is a typed error', () => {
    const err = new ChatMessageOwnershipError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ChatMessageOwnershipError');
  });
});

describe('Chat room categories', () => {
  it('exposes the complete persisted category set', () => {
    expect(CHAT_ROOM_CATEGORIES).toEqual([
      'games-sports',
      'regions',
      'languages',
      'private-channels',
    ]);
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

  it('counts each authenticated user once across multiple stream connections', async () => {
    const transport = new InProcessRealtimeTransport();
    const service = new ChatService(
      mockDb({}),
      mock<EventBus>({ emit: () => undefined }),
      transport,
    );

    const first = service.subscribeMessages('r1', () => undefined, 'u1', 'tab-1');
    const second = service.subscribeMessages('r1', () => undefined, 'u1', 'tab-2');

    await expect(service.getOnlineCount('r1')).resolves.toEqual({ count: 1 });
    first();
    await expect(service.getOnlineCount('r1')).resolves.toEqual({ count: 1 });
    second();
    await expect(service.getOnlineCount('r1')).resolves.toEqual({ count: 0 });
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

function makeAdminService(drizzle: DrizzleService) {
  return new ChatService(
    drizzle,
    mock<EventBus>({ emit: () => undefined }),
    new InProcessRealtimeTransport(),
  );
}

// Public room row shape shared by admin room tests.
const publicRoomRow = {
  id: 'r1',
  name: 'Jackpot Wheel',
  slug: 'jackpot-wheel',
  category: 'games-sports',
  isPublic: true,
  joinCode: null,
  creatorId: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

describe('ChatService.createRoom', () => {
  it('creates a room and returns the serialized row', async () => {
    // (1) slug uniqueness check -> empty, (2) insert -> no-op via select queue.
    const drizzle = makeDrizzle({ select: [[]], returning: [[publicRoomRow]] });
    const result = await makeAdminService(drizzle).createRoom({
      name: 'Jackpot Wheel',
      slug: 'jackpot-wheel',
      category: 'games-sports',
    });
    expect(result.id).toBe('r1');
    expect(result.slug).toBe('jackpot-wheel');
    expect(result.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('throws ChatRoomSlugConflictError when slug already exists', async () => {
    // slug uniqueness check -> existing row found.
    const drizzle = makeDrizzle({ select: [[{ id: 'existing' }]] });
    await expect(
      makeAdminService(drizzle).createRoom({
        name: 'Jackpot Wheel',
        slug: 'jackpot-wheel',
        category: 'games-sports',
      }),
    ).rejects.toThrow(ChatRoomSlugConflictError);
  });
});

describe('ChatService.listAdminRooms', () => {
  it('returns a paginated public-room list for the requested sort', async () => {
    const drizzle = makeDrizzle({ select: [[publicRoomRow], [{ n: 1 }]] });

    await expect(
      makeAdminService(drizzle).listAdminRooms({
        page: 2,
        limit: 10,
        sortBy: 'name',
        sortOrder: 'asc',
      }),
    ).resolves.toEqual({
      items: [{ ...publicRoomRow, createdAt: '2026-01-01T00:00:00.000Z' }],
      total: 1,
      page: 2,
      limit: 10,
    });
  });
});

describe('ChatService.updateRoom', () => {
  it('updates a room and emits an audit-ready before/after event', async () => {
    const updatedRoom = {
      ...publicRoomRow,
      name: 'Mega Wheel',
      slug: 'mega-wheel',
      category: 'regions',
    };
    const drizzle = makeDrizzle({ select: [[publicRoomRow]], returning: [[updatedRoom]] });
    const events = makeEvents();
    const service = new ChatService(
      drizzle,
      mock<EventBus>(events),
      new InProcessRealtimeTransport(),
    );

    await expect(
      service.updateRoom({
        id: 'r1',
        name: 'Mega Wheel',
        slug: 'mega-wheel',
        category: 'regions',
        actorId: 'admin-1',
      }),
    ).resolves.toMatchObject({ name: 'Mega Wheel', slug: 'mega-wheel', category: 'regions' });

    expect(events.emit).toHaveBeenCalledWith('chat.room.updated', {
      roomId: 'r1',
      actorId: 'admin-1',
      before: { name: 'Jackpot Wheel', slug: 'jackpot-wheel', category: 'games-sports' },
      after: { name: 'Mega Wheel', slug: 'mega-wheel', category: 'regions' },
    });
  });
});

describe('ChatService.deleteRoom', () => {
  it('soft-deletes the room and returns success', async () => {
    // Single UPDATE...RETURNING sets deletedAt; findOneOrThrow consumes the result.
    const drizzle = makeDrizzle({
      returning: [[{ id: 'r1', name: 'n', slug: 's', category: 'games-sports' }]],
    });
    const result = await makeAdminService(drizzle).deleteRoom('r1');
    expect(result).toEqual({ success: true });
  });

  it('throws ChatRoomNotFoundError when room does not exist', async () => {
    // UPDATE matches no rows -> returning empty -> findOneOrThrow throws.
    const drizzle = makeDrizzle({ returning: [[]] });
    await expect(makeAdminService(drizzle).deleteRoom('nonexistent')).rejects.toThrow(
      ChatRoomNotFoundError,
    );
  });
});

// Private room row shape shared by private room tests.
const privateRoomRow = {
  id: 'r2',
  name: 'Squad Chat',
  slug: 'private-ef1f8d41-e0ac-4ad3-bd93-3a55e047eb38',
  category: 'private-channels',
  isPublic: false,
  joinCode: 'ABC123',
  creatorId: 'u1',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

describe('ChatService.createPrivateRoom', () => {
  it('creates a private room, joins creator as moderator, and returns serialized row', async () => {
    // (1) count private rooms -> 0, in tx: (2) insert chatRoom -> returning[0], (3) insert member -> no-op
    const drizzle = makeDrizzle({ select: [[{ total: 0 }], []], returning: [[privateRoomRow]] });
    const result = await makeAdminService(drizzle).createPrivateRoom({
      userId: 'u1',
      name: 'Squad Chat',
    });
    expect(result.id).toBe('r2');
    expect(result.isPublic).toBe(false);
    expect(result.joinCode).toBe('ABC123');
    expect(result.creatorId).toBe('u1');
    expect(result.category).toBe('private-channels');
  });

  it('generates a separate URL-safe slug instead of exposing the join code', async () => {
    const drizzle = makeDrizzle({ select: [[{ total: 0 }], []], returning: [[privateRoomRow]] });
    const valuesSpy = readPrivate<ReturnType<typeof vi.fn>>(drizzle.db, 'values');

    await makeAdminService(drizzle).createPrivateRoom({ userId: 'u1', name: 'Squad Chat' });

    const [room] = valuesSpy.mock.calls[0] ?? [];
    expect(room).toMatchObject({ joinCode: expect.any(String) });
    expect(room).toMatchObject({
      slug: expect.stringMatching(/^private-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/),
    });
    expect(room.slug).not.toContain(room.joinCode.toLowerCase());
  });

  it('rejects creating a sixteenth active private room', async () => {
    const drizzle = makeDrizzle({ select: [[{ total: 15 }]] });

    await expect(
      makeAdminService(drizzle).createPrivateRoom({ userId: 'u1', name: 'One Too Many' }),
    ).rejects.toThrow(ChatRoomLimitReachedError);
  });

  it('takes a creator-scoped advisory lock before counting and inserting', async () => {
    const drizzle = makeDrizzle({ select: [[{ total: 0 }]], returning: [[privateRoomRow]] });
    const executeSpy = readPrivate<ReturnType<typeof vi.fn>>(drizzle.db, 'execute');

    await makeAdminService(drizzle).createPrivateRoom({ userId: 'u1', name: 'Squad Chat' });

    expect(executeSpy).toHaveBeenCalledTimes(1);
  });
});

describe('ChatService.joinRoom', () => {
  it('joins a private room via join code and returns the room', async () => {
    // (1) find room id by joinCode, (2) re-read room under the membership lock, (3) check ban.
    const drizzle = makeDrizzle({ select: [[{ id: 'r2' }], [privateRoomRow], []] });
    const result = await makeAdminService(drizzle).joinRoom({ userId: 'u2', joinCode: 'ABC123' });
    expect(result.id).toBe('r2');
    expect(result.joinCode).toBe('ABC123');
  });

  it('throws ChatRoomJoinCodeNotFoundError when code does not match any room', async () => {
    // (1) find room by joinCode -> empty
    const drizzle = makeDrizzle({ select: [[]] });
    await expect(
      makeAdminService(drizzle).joinRoom({ userId: 'u2', joinCode: 'BADCODE' }),
    ).rejects.toThrow(ChatRoomJoinCodeNotFoundError);
  });

  it('throws ChatRoomBannedError when user is banned from the room', async () => {
    // (1) find room id by joinCode, (2) re-read room, (3) check ban -> ban record found
    const drizzle = makeDrizzle({
      select: [[{ id: 'r2' }], [privateRoomRow], [{ id: 'ban1' }]],
    });
    await expect(
      makeAdminService(drizzle).joinRoom({ userId: 'u2', joinCode: 'ABC123' }),
    ).rejects.toThrow(ChatRoomBannedError);
  });
});

describe('ChatService.kickMember', () => {
  it('kicks a member from a private room and returns success', async () => {
    // Access check (room + membership), then moderator lookup and member deletion.
    const drizzle = makeDrizzle({
      select: [[privateRoomRow], [{ id: 'mem1' }], [{ role: 'moderator' }]],
    });
    const result = await makeAdminService(drizzle).kickMember({
      moderatorId: 'u1',
      roomId: 'r2',
      userId: 'u2',
    });
    expect(result).toEqual({ success: true });
  });

  it('throws ChatRoomNotModeratorError when caller is not a moderator', async () => {
    const drizzle = makeDrizzle({
      select: [[privateRoomRow], [{ id: 'mem1' }], [{ role: 'member' }]],
    });
    await expect(
      makeAdminService(drizzle).kickMember({ moderatorId: 'u1', roomId: 'r2', userId: 'u2' }),
    ).rejects.toThrow(ChatRoomNotModeratorError);
  });

  it('throws ChatRoomNotModeratorError when caller is not in the room', async () => {
    const drizzle = makeDrizzle({ select: [[privateRoomRow], [{ id: 'mem1' }], []] });
    await expect(
      makeAdminService(drizzle).kickMember({ moderatorId: 'u1', roomId: 'r2', userId: 'u2' }),
    ).rejects.toThrow(ChatRoomNotModeratorError);
  });

  it('throws ChatRoomSelfModerationError when trying to kick yourself', async () => {
    const drizzle = makeDrizzle({ select: [] });
    await expect(
      makeAdminService(drizzle).kickMember({ moderatorId: 'u1', roomId: 'r2', userId: 'u1' }),
    ).rejects.toThrow(ChatRoomSelfModerationError);
  });
});

describe('ChatService.banMember', () => {
  it('bans a member from a private room (also removes membership) and returns success', async () => {
    // Access check (room + membership), then moderator lookup, ban insertion, and member deletion.
    const drizzle = makeDrizzle({
      select: [[privateRoomRow], [{ id: 'mem1' }], [{ role: 'moderator' }]],
    });
    const result = await makeAdminService(drizzle).banMember({
      moderatorId: 'u1',
      roomId: 'r2',
      userId: 'u2',
    });
    expect(result).toEqual({ success: true });
  });

  it('throws ChatRoomNotModeratorError when caller is not a moderator', async () => {
    const drizzle = makeDrizzle({ select: [[privateRoomRow], [{ id: 'mem1' }], []] });
    await expect(
      makeAdminService(drizzle).banMember({ moderatorId: 'u1', roomId: 'r2', userId: 'u2' }),
    ).rejects.toThrow(ChatRoomNotModeratorError);
  });

  it('throws ChatRoomSelfModerationError when trying to ban yourself', async () => {
    const drizzle = makeDrizzle({ select: [] });
    await expect(
      makeAdminService(drizzle).banMember({ moderatorId: 'u1', roomId: 'r2', userId: 'u1' }),
    ).rejects.toThrow(ChatRoomSelfModerationError);
  });
});

describe('ChatService.verifyRoomAccess', () => {
  it('returns the room for public rooms without checking membership', async () => {
    // (1) room lookup -> public room
    const drizzle = makeDrizzle({ select: [[publicRoomRow]] });
    const room = await makeAdminService(drizzle).verifyRoomAccess('r1');
    expect(room.id).toBe('r1');
  });

  it('throws ChatRoomNotFoundError when room does not exist', async () => {
    const drizzle = makeDrizzle({ select: [[]] });
    await expect(makeAdminService(drizzle).verifyRoomAccess('r1')).rejects.toThrow(
      ChatRoomNotFoundError,
    );
  });

  it('throws ChatRoomNotMemberError for private rooms when no viewerId supplied', async () => {
    // (1) room lookup -> private room
    const drizzle = makeDrizzle({ select: [[privateRoomRow]] });
    await expect(makeAdminService(drizzle).verifyRoomAccess('r2')).rejects.toThrow(
      ChatRoomNotMemberError,
    );
  });

  it('throws ChatRoomNotMemberError for private rooms when viewer is not a member', async () => {
    // (1) room lookup -> private room, (2) member check -> empty
    const drizzle = makeDrizzle({ select: [[privateRoomRow], []] });
    await expect(makeAdminService(drizzle).verifyRoomAccess('r2', 'outsider')).rejects.toThrow(
      ChatRoomNotMemberError,
    );
  });

  it('allows access for private rooms when viewer is a member', async () => {
    // (1) room lookup -> private room, (2) member check -> member record
    const drizzle = makeDrizzle({ select: [[privateRoomRow], [{ id: 'mem1' }]] });
    const room = await makeAdminService(drizzle).verifyRoomAccess('r2', 'u1');
    expect(room.id).toBe('r2');
  });
});

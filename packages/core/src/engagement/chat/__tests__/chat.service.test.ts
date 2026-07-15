import { describe, it, expect } from 'vitest';
import {
  InProcessRealtimeTransport,
  type EventBus,
  type DrizzleService,
} from '@openora/core/server';
import type { ChatMessage } from '../contract/index.js';
import { mock, mockDb, makeDrizzle } from '../../../testing/mock.js';
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
  ChatRoomNotMemberError,
  ChatRoomNotModeratorError,
  ChatRoomSelfModerationError,
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
    });
    expect(result.id).toBe('r1');
    expect(result.slug).toBe('jackpot-wheel');
    expect(result.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('throws ChatRoomSlugConflictError when slug already exists', async () => {
    // slug uniqueness check -> existing row found.
    const drizzle = makeDrizzle({ select: [[{ id: 'existing' }]] });
    await expect(
      makeAdminService(drizzle).createRoom({ name: 'Jackpot Wheel', slug: 'jackpot-wheel' }),
    ).rejects.toThrow(ChatRoomSlugConflictError);
  });
});

describe('ChatService.deleteRoom', () => {
  it('deletes room messages then the room and returns success', async () => {
    // In tx: (1) delete chatMessage (awaited, pops select), (2) delete chatRoom (pops returning).
    const drizzle = makeDrizzle({ select: [[]], returning: [[{ id: 'r1' }]] });
    const result = await makeAdminService(drizzle).deleteRoom('r1');
    expect(result).toEqual({ success: true });
  });

  it('throws ChatRoomNotFoundError when room does not exist', async () => {
    // (1) delete chatMessage ok, (2) delete chatRoom returns nothing -> not found.
    const drizzle = makeDrizzle({ select: [[]], returning: [[]] });
    await expect(makeAdminService(drizzle).deleteRoom('nonexistent')).rejects.toThrow(
      ChatRoomNotFoundError,
    );
  });
});

// Private room row shape shared by private room tests.
const privateRoomRow = {
  id: 'r2',
  name: 'Squad Chat',
  slug: 'private-abc123',
  isPublic: false,
  joinCode: 'ABC123',
  creatorId: 'u1',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

describe('ChatService.createPrivateRoom', () => {
  it('creates a private room, joins creator as moderator, and returns serialized row', async () => {
    // (1) insert chatRoom -> returning[0], (2) insert chatRoomMember -> select[0] no-op
    const drizzle = makeDrizzle({ select: [[]], returning: [[privateRoomRow]] });
    const result = await makeAdminService(drizzle).createPrivateRoom({
      userId: 'u1',
      name: 'Squad Chat',
    });
    expect(result.id).toBe('r2');
    expect(result.isPublic).toBe(false);
    expect(result.joinCode).toBe('ABC123');
    expect(result.creatorId).toBe('u1');
  });
});

describe('ChatService.joinRoom', () => {
  it('joins a private room via join code and returns the room', async () => {
    // (1) find room by joinCode -> privateRoomRow, (2) check ban -> empty, (3) insert member -> no-op
    const drizzle = makeDrizzle({ select: [[privateRoomRow], [], []] });
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
    // (1) find room -> privateRoomRow, (2) check ban -> ban record found
    const drizzle = makeDrizzle({ select: [[privateRoomRow], [{ id: 'ban1' }]] });
    await expect(
      makeAdminService(drizzle).joinRoom({ userId: 'u2', joinCode: 'ABC123' }),
    ).rejects.toThrow(ChatRoomBannedError);
  });
});

describe('ChatService.kickMember', () => {
  it('kicks a member from a private room and returns success', async () => {
    // (1) moderator lookup -> moderator record, (2) delete member -> no-op
    const drizzle = makeDrizzle({ select: [[{ role: 'moderator' }], []] });
    const result = await makeAdminService(drizzle).kickMember({
      moderatorId: 'u1',
      roomId: 'r2',
      userId: 'u2',
    });
    expect(result).toEqual({ success: true });
  });

  it('throws ChatRoomNotModeratorError when caller is not a moderator', async () => {
    // (1) moderator lookup -> member role
    const drizzle = makeDrizzle({ select: [[{ role: 'member' }]] });
    await expect(
      makeAdminService(drizzle).kickMember({ moderatorId: 'u1', roomId: 'r2', userId: 'u2' }),
    ).rejects.toThrow(ChatRoomNotModeratorError);
  });

  it('throws ChatRoomNotModeratorError when caller is not in the room', async () => {
    // (1) moderator lookup -> not found
    const drizzle = makeDrizzle({ select: [[]] });
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
    // (1) moderator lookup -> moderator, (2) insert ban -> no-op, (3) delete member -> no-op
    const drizzle = makeDrizzle({ select: [[{ role: 'moderator' }], [], []] });
    const result = await makeAdminService(drizzle).banMember({
      moderatorId: 'u1',
      roomId: 'r2',
      userId: 'u2',
    });
    expect(result).toEqual({ success: true });
  });

  it('throws ChatRoomNotModeratorError when caller is not a moderator', async () => {
    const drizzle = makeDrizzle({ select: [[]] });
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

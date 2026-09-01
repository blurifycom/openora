import { describe, it, expect, vi } from 'vitest';
import { call, ORPCError } from '@orpc/server';
import type { AdminGuard } from '@openora/core/server';
import type {
  ChatModeration,
  RateLimiterAdapter,
  RealtimeClientAuthorizer,
} from '@openora/core/contracts';
import { mock, testContext } from '../../../testing/mock.js';
import { createChatRouter } from '../router/index.js';
import type { ChatService } from '../service/chat.service.js';
import type { ChatRoomMembershipService } from '../service/chat-room-membership.service.js';
import type { ChatRoomBanService } from '../service/chat-room-ban.service.js';
import type { ChatRoomMuteService } from '../service/chat-room-mute.service.js';
import {
  ChatRoomLastModeratorError,
  ChatRoomNotFoundError,
  ChatRoomNotMemberError,
} from '../service/errors/chat-moderation.errors.js';

const ROOM_ID = '9a2f7c11-0000-4000-8000-000000000001';
const USER_ID = '9a2f7c11-0000-4000-8000-000000000002';
const CTX = testContext({ auth: { userId: USER_ID } });

function routerWithLeaveRoom(leaveRoom: () => Promise<unknown>) {
  return createChatRouter({
    chatService: mock<ChatService>({}),
    membershipService: mock<ChatRoomMembershipService>({ leaveRoom }),
    roomBanService: mock<ChatRoomBanService>({}),
    roomMuteService: mock<ChatRoomMuteService>({}),
    moderationService: mock<ChatModeration>({}),
    authorizer: mock<RealtimeClientAuthorizer>({}),
    adminGuard: mock<AdminGuard>({}),
    limiter: mock<RateLimiterAdapter>({}),
  });
}

function leaveRoomCode(error: Error) {
  return call(
    routerWithLeaveRoom(vi.fn().mockRejectedValue(error)).leaveRoom,
    { roomId: ROOM_ID },
    { context: CTX },
  ).then(
    () => 'no error',
    (err: unknown) => (err instanceof ORPCError ? err.code : 'not an ORPCError'),
  );
}

describe('chat router leaveRoom error mapping', () => {
  it('leaves a room the caller is still in', async () => {
    const router = routerWithLeaveRoom(vi.fn().mockResolvedValue({ success: true }));

    await expect(call(router.leaveRoom, { roomId: ROOM_ID }, { context: CTX })).resolves.toEqual({
      success: true,
    });
  });

  it('answers NOT_FOUND when the room is already deleted', async () => {
    await expect(leaveRoomCode(new ChatRoomNotFoundError(ROOM_ID))).resolves.toBe('NOT_FOUND');
  });

  it('answers FORBIDDEN when the caller is not a member', async () => {
    await expect(leaveRoomCode(new ChatRoomNotMemberError(ROOM_ID))).resolves.toBe('FORBIDDEN');
  });

  it('still answers BAD_REQUEST for the last moderator', async () => {
    await expect(leaveRoomCode(new ChatRoomLastModeratorError())).resolves.toBe('BAD_REQUEST');
  });

  it('leaves an unmapped failure as an internal error', async () => {
    await expect(leaveRoomCode(new Error('connection reset'))).resolves.toBe('not an ORPCError');
  });
});

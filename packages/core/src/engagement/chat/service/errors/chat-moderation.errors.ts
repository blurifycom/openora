import { createDomainError, makeNotFoundError } from '@openora/core/server';
import type { Uuid } from '@openora/core/contracts';

export const ChatRoomNotFoundError = makeNotFoundError('ChatRoom');
export const ChatMessageNotFoundError = makeNotFoundError('ChatMessage');
export type ChatRestrictionData = { until: string | null };

export class ChatPlayerMutedError extends Error {
  readonly data: ChatRestrictionData;

  constructor(until: Date | string | null) {
    super(
      until === null
        ? "You are muted until a chat moderator's decision"
        : `You are muted until ${until instanceof Date ? until.toISOString() : until}`,
    );
    this.name = 'ChatPlayerMutedError';
    this.data = { until: until instanceof Date ? until.toISOString() : until };
  }
}

export class ChatPlayerBannedError extends Error {
  readonly data: ChatRestrictionData;

  constructor(until: Date | string | null) {
    super(
      until === null
        ? "You are banned until a chat moderator's decision"
        : `You are banned until ${until instanceof Date ? until.toISOString() : until}`,
    );
    this.name = 'ChatPlayerBannedError';
    this.data = { until: until instanceof Date ? until.toISOString() : until };
  }
}
export const ChatAdminPrivateRoomModerationError = createDomainError(
  'ChatAdminPrivateRoomModerationError',
  () => 'Admin moderation only applies to global or public chat rooms',
);
export const ChatRoomNotMemberError = createDomainError(
  'ChatRoomNotMemberError',
  (roomId: Uuid) => `You are not a member of room: ${roomId}`,
);
export const ChatRoomNotModeratorError = createDomainError(
  'ChatRoomNotModeratorError',
  (roomId: Uuid) => `You are not a moderator of room: ${roomId}`,
);
export const ChatRoomSelfModerationError = createDomainError(
  'ChatRoomSelfModerationError',
  () => 'You cannot kick or ban yourself',
);
export const ChatRoomLastModeratorError = createDomainError(
  'ChatRoomLastModeratorError',
  () => 'Cannot leave: you are the sole moderator of this room',
);
export const ChatRoomOwnerCannotLeaveError = createDomainError(
  'ChatRoomOwnerCannotLeaveError',
  () => 'Cannot leave: transfer ownership or delete the room first',
);
export const ChatRoomJoinCodeNotFoundError = createDomainError(
  'ChatRoomJoinCodeNotFoundError',
  (code: string) => `No room found with join code: ${code}`,
);
export const ChatRoomBannedError = createDomainError(
  'ChatRoomBannedError',
  (roomId: Uuid) => `You are banned from room: ${roomId}`,
);

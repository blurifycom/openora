import { createDomainError, makeNotFoundError } from '@openora/core/server';
import type { Uuid } from '@openora/core/contracts';

export const ChatRoomNotFoundError = makeNotFoundError('ChatRoom');
export const ChatMessageNotFoundError = makeNotFoundError('ChatMessage');
export const ChatPlayerMutedError = createDomainError(
  'ChatPlayerMutedError',
  () => 'You are muted in this chat channel',
);
export const ChatPlayerBannedError = createDomainError(
  'ChatPlayerBannedError',
  () => 'You are banned from public chat',
);
export const ChatAdminPrivateRoomModerationError = createDomainError(
  'ChatAdminPrivateRoomModerationError',
  () => 'Admin mutes only apply to global or public chat rooms',
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
export const ChatRoomJoinCodeNotFoundError = createDomainError(
  'ChatRoomJoinCodeNotFoundError',
  (code: string) => `No room found with join code: ${code}`,
);
export const ChatRoomBannedError = createDomainError(
  'ChatRoomBannedError',
  (roomId: Uuid) => `You are banned from room: ${roomId}`,
);

import { createDomainError, makeNotFoundError } from '@openora/core/server';
import type { Uuid } from '@openora/core/contracts';

export const ChatRoomInviteNotFoundError = makeNotFoundError('ChatRoomInvite');
export const ChatRoomInviteForbiddenError = createDomainError(
  'ChatRoomInviteForbiddenError',
  (roomId: Uuid) => `You cannot invite players to room: ${roomId}`,
  { reason: 'forbidden' },
);
export const ChatRoomInviteSelfError = createDomainError(
  'ChatRoomInviteSelfError',
  () => 'You cannot invite yourself',
  { reason: 'self' },
);
export const ChatRoomInviteeNotPlayerError = createDomainError(
  'ChatRoomInviteeNotPlayerError',
  (userId: Uuid) => `Only players can be invited: ${userId}`,
  { reason: 'not_player' },
);
export const ChatRoomInviteeUnavailableError = createDomainError(
  'ChatRoomInviteeUnavailableError',
  (userId: Uuid) => `This player cannot be invited: ${userId}`,
  { reason: 'unavailable' },
);
export const ChatRoomInviteeBannedError = createDomainError(
  'ChatRoomInviteeBannedError',
  (userId: Uuid) => `This player is banned from the room: ${userId}`,
  { reason: 'banned' },
);
export const ChatRoomInviteeAlreadyMemberError = createDomainError(
  'ChatRoomInviteeAlreadyMemberError',
  (userId: Uuid) => `This player is already a member: ${userId}`,
  { reason: 'member' },
);
export const ChatRoomInvitePendingError = createDomainError(
  'ChatRoomInvitePendingError',
  (userId: Uuid) => `This player already has a pending invite: ${userId}`,
  { reason: 'invited' },
);
export const ChatRoomInviterBlockedError = createDomainError(
  'ChatRoomInviterBlockedError',
  () => 'You have blocked the player who sent this invite',
  { reason: 'blocked' },
);

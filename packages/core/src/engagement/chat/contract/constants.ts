export const MAX_MESSAGE_LENGTH = 500;
export const DEFAULT_MESSAGE_LIMIT = 50;
export const ROOM_NAME_MAX_LENGTH = 100;
export const ROOM_SLUG_MAX_LENGTH = 100;

export const JOIN_CODE_LENGTH = 6;
export const JOIN_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const JOIN_CODE_INPUT_MAX_LENGTH = 20;

export const PRIVATE_ROOM_SLUG_PREFIX = 'private-';

export const MAX_PRIVATE_ROOMS_PER_PLAYER = 15;

export const CHAT_ROOM_ROLES = ['member', 'moderator', 'owner'] as const;

// Roles a room owner can grant or revoke through the member-role route. `owner` is absent
// on purpose: ownership moves through its own transfer flow, never through a role write.
export const CHAT_ROOM_ASSIGNABLE_ROLES = ['member', 'moderator'] as const;

// Realtime signal published on a room's channel when a member's role changes, so connected
// clients refetch the roster instead of rendering a stale badge until their cache expires.
// Named alongside the transport's own `chat:access-revoked`; a client subscribes to it by name.
export const CHAT_MEMBER_ROLE_CHANGED_SIGNAL = 'chat:member-role-changed';

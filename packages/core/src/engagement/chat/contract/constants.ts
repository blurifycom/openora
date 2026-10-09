export const MAX_MESSAGE_LENGTH = 500;
export const DEFAULT_MESSAGE_LIMIT = 50;
export const ROOM_NAME_MAX_LENGTH = 100;
export const ROOM_SLUG_MAX_LENGTH = 100;
export const ROOM_RULE_MAX_LENGTH = 1000;
export const CHAT_COOLDOWN_SECONDS_MAX = 86_400;
export const CHAT_MODERATION_DURATION_SECONDS_MAX = 31_536_000;
export const CHAT_MODERATION_REASON_MAX_LENGTH = 500;
export const CONNECTION_CLIENT_ID_MAX_LENGTH = 128;

export const JOIN_CODE_LENGTH = 6;
export const JOIN_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const JOIN_CODE_INPUT_MAX_LENGTH = 20;

export const PRIVATE_ROOM_SLUG_PREFIX = 'private-';

export const MAX_PRIVATE_ROOMS_PER_PLAYER = 15;

export const ROOM_ACTIVITY_WINDOW_HOURS_DEFAULT = 24;
export const ROOM_ACTIVITY_WINDOW_HOURS_MAX = 168;

export const CHAT_ROOM_ROLES = ['member', 'moderator', 'owner'] as const;

export const CHAT_ROOM_RESTRICTION_TYPES = ['mute', 'ban', 'cooldown'] as const;
// `admin`: set by staff through the backoffice. `room`: set by the room's owner or a moderator.
export const CHAT_ROOM_RESTRICTION_SOURCES = ['admin', 'room'] as const;

// Roles a room owner can grant or revoke through the member-role route. `owner` is absent
// on purpose: ownership moves through its own transfer flow, never through a role write.
export const CHAT_ROOM_ASSIGNABLE_ROLES = ['member', 'moderator'] as const;

// Realtime signal published on a room's channel when a member's role changes, so connected
// clients refetch the roster instead of rendering a stale badge until their cache expires.
// Named alongside the transport's own ACCESS_REVOKED_SIGNAL; a client subscribes to it by name.
export const CHAT_MEMBER_ROLE_CHANGED_SIGNAL = 'chat:member-role-changed';

export const CHAT_MEMBER_JOINED_SIGNAL = 'chat:member-joined';

export const CHAT_ROOM_SCHEDULED_FOR_DELETION_SIGNAL = 'chat:room-scheduled-for-deletion';

export const OWNERLESS_ROOM_RETENTION_DAYS = 30;

export const CHAT_ROOM_INVITE_STATUSES = ['pending', 'accepted', 'declined', 'expired'] as const;

export const CHAT_ROOM_INVITE_CANDIDATE_STATUSES = [
  'available',
  'member',
  'invited',
  'banned',
] as const;

// `unavailable` marks an id that is not a player.
export const CHAT_ROOM_INVITE_LOOKUP_STATUSES = [
  ...CHAT_ROOM_INVITE_CANDIDATE_STATUSES,
  'unavailable',
] as const;

export const ROOM_INVITE_EXPIRY_DAYS = 7;

export const ROOM_INVITE_STATUS_LOOKUP_MAX = 100;

export const ROOM_INVITE_CANDIDATE_LIMIT_MAX = 50;

export const ROOM_INVITE_SEARCH_MIN_LENGTH = 3;

export const ROOM_INVITE_SEARCH_MAX_LENGTH = 50;

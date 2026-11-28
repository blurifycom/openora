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
export const CONTEXT_ROOM_SLUG_PREFIX = 'context-';

export const CHAT_ROOM_KINDS = ['standard', 'context'] as const;

export const MAX_PRIVATE_ROOMS_PER_PLAYER = 15;

export const ROOM_ACTIVITY_WINDOW_HOURS_DEFAULT = 24;
export const ROOM_ACTIVITY_WINDOW_HOURS_MAX = 168;

export const CHAT_ROOM_ROLES = ['member', 'moderator', 'owner'] as const;

export const STAFF_USER_ROLES = ['admin', 'super-admin'] as const;

export const isStaffRole = (role: string | undefined) =>
  STAFF_USER_ROLES.some((staffRole) => staffRole === role);

export const UNKNOWN_PLAYER_USERNAME = 'Unknown player';

export const CHAT_ROOM_RESTRICTION_TYPES = ['mute', 'ban', 'cooldown'] as const;
export const CHAT_ROOM_RESTRICTION_SOURCES = ['admin', 'room'] as const;

export const CHAT_ROOM_ASSIGNABLE_ROLES = ['member', 'moderator'] as const;

export const CHAT_MEMBER_ROLE_CHANGED_SIGNAL = 'chat:member-role-changed';

export const CHAT_MEMBER_JOINED_SIGNAL = 'chat:member-joined';

export const CHAT_ROOM_SCHEDULED_FOR_DELETION_SIGNAL = 'chat:room-scheduled-for-deletion';

export const CHAT_ROOM_CLOSED_SIGNAL = 'chat:room-closed';

export const OWNERLESS_ROOM_RETENTION_DAYS = 30;

export const CHAT_ROOM_INVITE_STATUSES = ['pending', 'accepted', 'declined', 'expired'] as const;

export const CHAT_ROOM_INVITE_CANDIDATE_STATUSES = [
  'available',
  'member',
  'invited',
  'banned',
] as const;

export const CHAT_ROOM_INVITE_LOOKUP_STATUSES = [
  ...CHAT_ROOM_INVITE_CANDIDATE_STATUSES,
  'unavailable',
] as const;

export const ROOM_INVITE_EXPIRY_DAYS = 7;

export const ROOM_INVITE_STATUS_LOOKUP_MAX = 100;

export const ROOM_INVITE_CANDIDATE_LIMIT_MAX = 50;

export const ROOM_INVITE_SEARCH_MIN_LENGTH = 3;

export const ROOM_INVITE_SEARCH_MAX_LENGTH = 50;

import { oc, eventIterator } from '@orpc/contract';
import * as z from 'zod';
import {
  IdInputSchema,
  TimestampSchema,
  UuidSchema,
  GLOBAL_CHAT_ROOM_ID,
  CommandMetadataSchema,
  SystemChatMessageSchema,
} from '@openora/core/contracts';
import { PageQuerySchema, SortOrderSchema, paginated } from '@openora/core/contracts/kit';
import {
  MAX_MESSAGE_LENGTH,
  ROOM_NAME_MAX_LENGTH,
  ROOM_SLUG_MAX_LENGTH,
  JOIN_CODE_INPUT_MAX_LENGTH,
  CHAT_ROOM_ROLES,
} from './constants.js';

export * from './constants.js';

export const AdminRoomSortByValues = ['name', 'createdAt'] as const;
export const AdminRoomSortBySchema = z.enum(AdminRoomSortByValues).default('createdAt');
export type AdminRoomSortBy = z.infer<typeof AdminRoomSortBySchema>;
export const ModeratedRoomSortBySchema = z.enum(['name', 'createdAt']).default('name');
export type ModeratedRoomSortBy = z.infer<typeof ModeratedRoomSortBySchema>;

export type SortOrder = z.infer<typeof SortOrderSchema>;

const QueryBooleanSchema = z.preprocess(
  (value) => (value === 'true' ? true : value === 'false' ? false : value),
  z.boolean(),
);

// kebab-case slug: lowercase alphanum + hyphens, no leading/trailing hyphen.
export const ChatRoomSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(ROOM_SLUG_MAX_LENGTH)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const MessageContentSchema = z.string().trim().min(1).max(MAX_MESSAGE_LENGTH);

export const ChatRoomRoleSchema = z.enum(CHAT_ROOM_ROLES);
export type ChatRoomRole = z.infer<typeof ChatRoomRoleSchema>;

export const CHAT_ROOM_CATEGORIES = [
  'games-sports',
  'regions',
  'languages',
  'private-channels',
] as const;
export const ChatRoomCategorySchema = z.enum(CHAT_ROOM_CATEGORIES);
export type ChatRoomCategory = z.infer<typeof ChatRoomCategorySchema>;

export const ChatRoomSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  slug: z.string(),
  // The synthetic __global room has no category; categorized rooms use the enum.
  category: ChatRoomCategorySchema.nullable(),
  isPublic: z.boolean(),
  // Null for public rooms; populated for private rooms when the viewer is a member.
  joinCode: z.string().nullable(),
  creatorId: UuidSchema.nullable(),
  createdAt: TimestampSchema,
  isBanned: z.boolean(),
  bannedUntil: TimestampSchema.nullable(),
});
export type ChatRoom = z.infer<typeof ChatRoomSchema>;

export const ChatRoomMemberSchema = z.object({
  userId: UuidSchema,
  role: ChatRoomRoleSchema,
  joinedAt: TimestampSchema,
  username: z.string().nullable(),
});
export type ChatRoomMember = z.infer<typeof ChatRoomMemberSchema>;

export const ChatRoomRuleSchema = z.object({
  id: UuidSchema,
  roomId: UuidSchema,
  createdBy: UuidSchema,
  orderNum: z.number().int(),
  content: z.string(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type ChatRoomRule = z.infer<typeof ChatRoomRuleSchema>;

export const ChatRoomConfigurationSchema = z.object({
  id: UuidSchema,
  roomId: UuidSchema,
  slowMode: z.boolean(),
  slowModeSeconds: z.number().int().min(0),
  readOnlyMode: z.boolean(),
  onlyInvitedCanJoin: z.boolean(),
  lockRoom: z.boolean(),
  moderatorInvite: z.boolean(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type ChatRoomConfiguration = z.infer<typeof ChatRoomConfigurationSchema>;

export const ChatRoomAccessStatusSchema = z.enum(['all', 'member', 'owner']);
export type ChatRoomAccessStatus = z.infer<typeof ChatRoomAccessStatusSchema>;

export const ChatRoomUserSchema = z.object({
  userId: UuidSchema,
  username: z.string().nullable(),
  role: ChatRoomRoleSchema,
  joinedAt: TimestampSchema,
  blocked: z.boolean(),
  banId: UuidSchema.nullable(),
  banExpiresAt: TimestampSchema.nullable(),
});
export type ChatRoomUser = z.infer<typeof ChatRoomUserSchema>;

export const ChatRoomBanSchema = z.object({
  id: UuidSchema,
  roomId: UuidSchema,
  userId: UuidSchema,
  bannedBy: UuidSchema,
  createdAt: TimestampSchema,
  expiresAt: TimestampSchema.nullable(),
  liftedAt: TimestampSchema.nullable(),
});

const UserChatMessageSchema = z.object({
  id: UuidSchema,
  roomId: UuidSchema.nullable(),
  userId: UuidSchema,
  username: z.string(),
  // UNTRUSTED user text: profanity-gated and URL-defanged server-side but NOT HTML-escaped.
  // Consumers MUST render as text or escape before injecting into HTML.
  content: z.string(),
  type: z.literal('user'),
  metadata: CommandMetadataSchema.nullable(),
  isDeleted: z.boolean(),
  createdAt: TimestampSchema,
});
export const ChatMessageSchema = z.discriminatedUnion('type', [
  UserChatMessageSchema,
  SystemChatMessageSchema,
]);
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const AdminChatMessageDetailSchema = ChatMessageSchema.and(
  z.object({ playerId: UuidSchema.nullable() }),
);
export type AdminChatMessageDetail = z.infer<typeof AdminChatMessageDetailSchema>;

export const AdminChatMessageSchema = z.object({
  id: UuidSchema,
  date: TimestampSchema,
  roomId: UuidSchema.or(z.literal(GLOBAL_CHAT_ROOM_ID)),
  playerId: UuidSchema.nullable(),
  roomName: z.string(),
  content: z.string(),
  time: z.string(),
});
export type AdminChatMessage = z.infer<typeof AdminChatMessageSchema>;

export const BlockedUserSchema = z.object({
  blockedId: UuidSchema,
  createdAt: TimestampSchema,
});

export const BLOCKED_USER_SORT_BY_VALUES = ['createdAt'] as const;
export const BlockedUserSortBySchema = z.enum(BLOCKED_USER_SORT_BY_VALUES).default('createdAt');
export type BlockedUserSortBy = z.infer<typeof BlockedUserSortBySchema>;

export const IgnoredUserSchema = z.object({
  ignoredId: UuidSchema,
  createdAt: TimestampSchema,
});

export const IGNORED_USER_SORT_BY_VALUES = ['createdAt'] as const;
export const IgnoredUserSortBySchema = z.enum(IGNORED_USER_SORT_BY_VALUES).default('createdAt');
export type IgnoredUserSortBy = z.infer<typeof IgnoredUserSortBySchema>;

// Backoffice-only, site-wide views (distinct from the per-caller BlockedUserSchema/
// IgnoredUserSchema above): who blocked/ignored whom, across every user.
export const AdminBlockedUserSchema = z.object({
  blockerId: UuidSchema,
  blockedId: UuidSchema,
  createdAt: TimestampSchema,
});

export const AdminIgnoredUserSchema = z.object({
  ignorerId: UuidSchema,
  ignoredId: UuidSchema,
  createdAt: TimestampSchema,
});

export const ChatOnlineCountSchema = z.object({ count: z.number().int().min(0) });

// `.loose()` keeps this an open union so a managed-vendor overlay (eg Ably) can return extra fields without a contract change.
export const ChatConnectionGrantSchema = z
  .object({
    provider: z.string(),
    channels: z.array(z.string()),
  })
  .loose();

export const ChatModerationResultSchema = z.object({ success: z.literal(true) });
export const CHAT_MODERATION_SCOPES = ['__global', '__all_public', '__all'] as const;
export const ChatModerationRoomIdSchema = z.union([UuidSchema, z.enum(CHAT_MODERATION_SCOPES)]);
export type ChatModerationRoomId = z.infer<typeof ChatModerationRoomIdSchema>;
export const ChatModerationEntrySchema = z.object({
  id: UuidSchema,
  userId: UuidSchema,
  roomId: UuidSchema.nullable(),
  scope: ChatModerationRoomIdSchema,
  reason: z.string(),
  createdAt: TimestampSchema,
  expiresAt: TimestampSchema.nullable(),
});
export const ChatPlatformBanSchema = z.object({
  id: UuidSchema,
  userId: UuidSchema,
  reason: z.string(),
  createdAt: TimestampSchema,
  liftedAt: TimestampSchema.nullable(),
  bannedUntil: TimestampSchema.nullable(),
  roomId: UuidSchema.nullable(),
  scope: ChatModerationRoomIdSchema,
});

const AdminModerationInput = z.object({
  userId: UuidSchema,
  reason: z.string().trim().min(1).max(500),
  roomId: ChatModerationRoomIdSchema,
  durationSeconds: z.number().int().positive().max(31_536_000).nullable().default(null),
});
const AdminMuteInput = AdminModerationInput.extend({});

const RoomIdInput = z.object({ roomId: UuidSchema });
const RoomRulesInput = z.object({ roomId: UuidSchema.or(z.literal(GLOBAL_CHAT_ROOM_ID)) });
const RoomUserInput = z.object({ roomId: UuidSchema, userId: UuidSchema });
const RoomModerationInput = RoomUserInput.extend({
  reason: z.string().trim().min(1).max(500).default(''),
  durationSeconds: z.number().int().positive().max(31_536_000).nullable().default(null),
});
const ChatJoinCodeSchema = z.string().trim().min(1).max(JOIN_CODE_INPUT_MAX_LENGTH);

export const chatContract = {
  listRooms: oc.route({ method: 'GET', path: '/chat/rooms' }).output(z.array(ChatRoomSchema)),

  listModeratedRooms: oc
    .route({ method: 'GET', path: '/chat/rooms/moderated' })
    .input(
      z.object({
        ...PageQuerySchema.shape,
        name: z.string().trim().max(ROOM_NAME_MAX_LENGTH).optional(),
        sortBy: ModeratedRoomSortBySchema,
        sortOrder: SortOrderSchema.default('asc'),
      }),
    )
    .output(paginated(ChatRoomSchema)),

  getRoomMessages: oc
    .route({ method: 'GET', path: '/chat/rooms/{roomId}/messages' })
    .input(
      z.object({
        roomId: UuidSchema,
        // Bounded so a caller cannot request an unbounded page.
        limit: z.number().int().min(1).max(100).optional(),
        before: z.string().optional(),
      }),
    )
    .output(z.array(ChatMessageSchema)),

  sendRoomMessage: oc
    .route({ method: 'POST', path: '/chat/rooms/{roomId}/messages' })
    .input(z.object({ roomId: UuidSchema, content: MessageContentSchema }))
    .output(ChatMessageSchema),

  deleteMessage: oc
    .route({ method: 'DELETE', path: '/chat/messages/{id}' })
    .input(IdInputSchema)
    .output(z.object({ success: z.literal(true) })),

  getGlobalMessages: oc
    .route({ method: 'GET', path: '/chat/global' })
    .output(z.array(ChatMessageSchema)),

  sendGlobalMessage: oc
    .route({ method: 'POST', path: '/chat/global' })
    .input(z.object({ content: MessageContentSchema }))
    .output(ChatMessageSchema),

  getConnection: oc
    .route({ method: 'GET', path: '/chat/connection' })
    .input(z.object({ clientId: z.string().optional() }))
    .output(ChatConnectionGrantSchema),

  streamMessages: oc
    .route({ method: 'GET', path: '/chat/stream' })
    .input(z.object({ roomId: UuidSchema.nullable().optional() }))
    .output(eventIterator(ChatMessageSchema)),

  getOnlineCount: oc
    .route({ method: 'GET', path: '/chat/online-count' })
    .input(z.object({ roomId: UuidSchema.nullable().optional() }))
    .output(ChatOnlineCountSchema),

  listBlockedUsers: oc
    .route({ method: 'GET', path: '/chat/blocks' })
    .input(
      z.object({
        ...PageQuerySchema.shape,
        sortBy: BlockedUserSortBySchema,
        sortOrder: SortOrderSchema.default('desc'),
      }),
    )
    .output(paginated(BlockedUserSchema)),

  blockUser: oc
    .route({ method: 'POST', path: '/chat/blocks' })
    .input(z.object({ blockedId: UuidSchema }))
    .output(z.object({ success: z.literal(true) })),

  unblockUser: oc
    .route({ method: 'DELETE', path: '/chat/blocks/{blockedId}' })
    .input(z.object({ blockedId: UuidSchema }))
    .output(z.object({ success: z.literal(true) })),

  listIgnoredUsers: oc
    .route({ method: 'GET', path: '/chat/ignores' })
    .input(
      z.object({
        ...PageQuerySchema.shape,
        sortBy: IgnoredUserSortBySchema,
        sortOrder: SortOrderSchema.default('desc'),
      }),
    )
    .output(paginated(IgnoredUserSchema)),

  ignoreUser: oc
    .route({ method: 'POST', path: '/chat/ignores' })
    .input(z.object({ ignoredId: UuidSchema }))
    .output(z.object({ success: z.literal(true) })),

  unignoreUser: oc
    .route({ method: 'DELETE', path: '/chat/ignores/{ignoredId}' })
    .input(z.object({ ignoredId: UuidSchema }))
    .output(z.object({ success: z.literal(true) })),

  createPrivateRoom: oc
    .route({ method: 'POST', path: '/chat/rooms/private' })
    .input(z.object({ name: z.string().trim().min(1).max(ROOM_NAME_MAX_LENGTH) }))
    .output(ChatRoomSchema),

  deletePrivateRoom: oc
    .route({ method: 'DELETE', path: '/chat/rooms/{roomId}' })
    .input(RoomIdInput)
    .output(z.object({ success: z.literal(true) })),

  joinRoom: oc
    .route({ method: 'POST', path: '/chat/rooms/join' })
    .input(z.object({ joinCode: ChatJoinCodeSchema }))
    .output(ChatRoomSchema),

  joinPublicRoom: oc
    .route({ method: 'POST', path: '/chat/rooms/{roomId}/join' })
    .input(RoomIdInput)
    .output(ChatRoomSchema),

  adminJoinRoom: oc
    .route({ method: 'POST', path: '/backoffice/chat/rooms/{roomId}/join' })
    .input(RoomIdInput)
    .output(ChatRoomSchema),

  leaveRoom: oc
    .route({ method: 'POST', path: '/chat/rooms/{roomId}/leave' })
    .input(RoomIdInput)
    .output(z.object({ success: z.literal(true) })),

  getRoom: oc
    .route({ method: 'GET', path: '/chat/rooms/{roomId}' })
    .input(RoomIdInput)
    .output(ChatRoomSchema),

  getRoomRules: oc
    .route({ method: 'GET', path: '/chat/rooms/{roomId}/rules' })
    .input(RoomRulesInput)
    .output(z.array(ChatRoomRuleSchema)),

  createRoomRule: oc
    .route({ method: 'POST', path: '/chat/rooms/{roomId}/rules' })
    .input(
      z.object({
        roomId: UuidSchema,
        orderNum: z.number().int().positive().optional(),
        content: z.string().trim().min(1),
      }),
    )
    .output(ChatRoomRuleSchema),

  updateRoomRule: oc
    .route({ method: 'PATCH', path: '/chat/rooms/{roomId}/rules/{id}' })
    .input(
      z
        .object({
          roomId: UuidSchema,
          id: UuidSchema,
          orderNum: z.number().int().positive().optional(),
          content: z.string().trim().min(1).optional(),
        })
        .refine(({ orderNum, content }) => orderNum !== undefined || content !== undefined, {
          message: 'At least one rule field is required',
        }),
    )
    .output(ChatRoomRuleSchema),

  deleteRoomRule: oc
    .route({ method: 'DELETE', path: '/chat/rooms/{roomId}/rules/{id}' })
    .input(z.object({ roomId: UuidSchema, id: UuidSchema }))
    .output(z.object({ success: z.literal(true) })),

  getRoomConfiguration: oc
    .route({ method: 'GET', path: '/chat/rooms/{roomId}/configuration' })
    .input(RoomIdInput)
    .output(ChatRoomConfigurationSchema),

  updateRoomConfiguration: oc
    .route({ method: 'PATCH', path: '/chat/rooms/{roomId}/configuration' })
    .input(
      z.object({
        roomId: UuidSchema,
        slowMode: z.boolean().optional(),
        slowModeSeconds: z.number().int().min(0).optional(),
        readOnlyMode: z.boolean().optional(),
        onlyInvitedCanJoin: z.boolean().optional(),
        lockRoom: z.boolean().optional(),
        moderatorInvite: z.boolean().optional(),
      }),
    )
    .output(ChatRoomConfigurationSchema),

  listRoomUsers: oc
    .route({ method: 'GET', path: '/chat/rooms/{roomId}/users' })
    .input(z.object({ roomId: UuidSchema, status: ChatRoomAccessStatusSchema.default('all') }))
    .output(z.array(ChatRoomUserSchema)),

  listRoomBlockedUsers: oc
    .route({ method: 'GET', path: '/chat/rooms/{roomId}/blocked-users' })
    .input(z.object({ roomId: UuidSchema }))
    .output(z.array(ChatRoomBanSchema)),

  removeMember: oc
    .route({ method: 'POST', path: '/chat/rooms/{roomId}/remove' })
    .input(RoomUserInput)
    .output(z.object({ success: z.literal(true) })),

  banRoomMember: oc
    .route({ method: 'POST', path: '/chat/rooms/{roomId}/ban' })
    .input(RoomModerationInput)
    .output(z.object({ success: z.literal(true) })),

  unbanRoomMember: oc
    .route({ method: 'POST', path: '/chat/rooms/{roomId}/ban/lift' })
    .input(RoomUserInput)
    .output(z.object({ success: z.literal(true) })),

  muteRoomMember: oc
    .route({ method: 'POST', path: '/chat/rooms/{roomId}/mute' })
    .input(RoomModerationInput)
    .output(z.object({ success: z.literal(true) })),

  unmuteRoomMember: oc
    .route({ method: 'POST', path: '/chat/rooms/{roomId}/mute/lift' })
    .input(RoomUserInput)
    .output(z.object({ success: z.literal(true) })),

  listRoomMembers: oc
    .route({ method: 'GET', path: '/chat/rooms/{roomId}/members' })
    .input(RoomIdInput)
    .output(z.array(ChatRoomMemberSchema)),

  createRoom: oc
    .route({ method: 'POST', path: '/backoffice/chat/rooms' })
    .input(
      z.object({
        name: z.string().trim().min(1).max(ROOM_NAME_MAX_LENGTH),
        slug: ChatRoomSlugSchema,
        category: ChatRoomCategorySchema,
      }),
    )
    .output(ChatRoomSchema),

  updateRoom: oc
    .route({ method: 'PATCH', path: '/backoffice/chat/rooms/{id}' })
    .input(
      z
        .object({
          id: UuidSchema,
          name: z.string().trim().min(1).max(ROOM_NAME_MAX_LENGTH).optional(),
          slug: ChatRoomSlugSchema.optional(),
          category: ChatRoomCategorySchema.optional(),
        })
        .refine(
          ({ name, slug, category }) =>
            name !== undefined || slug !== undefined || category !== undefined,
          {
            message: 'At least one room field is required',
          },
        ),
    )
    .output(ChatRoomSchema),

  listAdminRooms: oc
    .route({ method: 'GET', path: '/backoffice/chat/rooms' })
    .input(
      z.object({
        ...PageQuerySchema.shape,
        name: z.string().trim().max(ROOM_NAME_MAX_LENGTH).optional(),
        sortBy: AdminRoomSortBySchema,
        sortOrder: SortOrderSchema.default('desc'),
      }),
    )
    .output(paginated(ChatRoomSchema)),

  adminListRoomMessages: oc
    .route({ method: 'GET', path: '/backoffice/chat/rooms/{roomId}/messages' })
    .input(
      z.object({
        roomId: UuidSchema.or(z.literal(GLOBAL_CHAT_ROOM_ID)),
        ...PageQuerySchema.shape,
        senderId: UuidSchema.optional(),
        playerId: UuidSchema.optional(),
        includeDeleted: QueryBooleanSchema.default(false),
      }),
    )
    .output(paginated(AdminChatMessageDetailSchema)),

  adminListMessages: oc
    .route({ method: 'GET', path: '/backoffice/chat/messages' })
    .input(
      z.object({
        ...PageQuerySchema.shape,
        roomId: UuidSchema.or(z.literal(GLOBAL_CHAT_ROOM_ID)).optional(),
        senderId: UuidSchema.optional(),
        playerId: UuidSchema.optional(),
        search: z.string().trim().max(MAX_MESSAGE_LENGTH).optional(),
        includeDeleted: QueryBooleanSchema.default(false),
        sortOrder: SortOrderSchema.default('desc'),
      }),
    )
    .output(paginated(AdminChatMessageSchema)),

  adminDeleteMessage: oc
    .route({ method: 'DELETE', path: '/backoffice/chat/messages/{id}' })
    .input(IdInputSchema)
    .output(z.object({ success: z.literal(true) })),

  deleteRoom: oc
    .route({ method: 'DELETE', path: '/backoffice/chat/rooms/{id}' })
    .input(IdInputSchema)
    .output(z.object({ success: z.literal(true) })),

  adminListBlockedUsers: oc
    .route({ method: 'GET', path: '/backoffice/chat/blocks' })
    .input(
      z.object({
        ...PageQuerySchema.shape,
        sortBy: BlockedUserSortBySchema,
        sortOrder: SortOrderSchema.default('desc'),
      }),
    )
    .output(paginated(AdminBlockedUserSchema)),

  adminListIgnoredUsers: oc
    .route({ method: 'GET', path: '/backoffice/chat/ignores' })
    .input(
      z.object({
        ...PageQuerySchema.shape,
        sortBy: IgnoredUserSortBySchema,
        sortOrder: SortOrderSchema.default('desc'),
      }),
    )
    .output(paginated(AdminIgnoredUserSchema)),

  adminMute: oc
    .route({ method: 'POST', path: '/backoffice/chat/mutes' })
    .input(AdminMuteInput)
    .output(ChatModerationResultSchema),

  adminUnmute: oc
    .route({ method: 'POST', path: '/backoffice/chat/mutes/lift' })
    .input(z.object({ userId: UuidSchema, roomId: ChatModerationRoomIdSchema }))
    .output(ChatModerationResultSchema),

  adminListMutes: oc
    .route({ method: 'GET', path: '/backoffice/chat/mutes' })
    .input(z.object({ userId: UuidSchema.optional() }))
    .output(z.array(ChatModerationEntrySchema)),

  adminBan: oc
    .route({ method: 'POST', path: '/backoffice/chat/bans' })
    .input(AdminModerationInput)
    .output(ChatModerationResultSchema),

  adminUnban: oc
    .route({ method: 'POST', path: '/backoffice/chat/bans/lift' })
    .input(z.object({ userId: UuidSchema, roomId: ChatModerationRoomIdSchema }))
    .output(ChatModerationResultSchema),

  adminListBans: oc
    .route({ method: 'GET', path: '/backoffice/chat/bans' })
    .input(z.object({ userId: UuidSchema.optional() }))
    .output(z.array(ChatPlatformBanSchema)),
};

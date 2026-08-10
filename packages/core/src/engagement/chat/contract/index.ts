import { oc, eventIterator } from '@orpc/contract';
import * as z from 'zod';
import {
  IdInputSchema,
  TimestampSchema,
  UuidSchema,
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

export type SortOrder = z.infer<typeof SortOrderSchema>;

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
  category: ChatRoomCategorySchema,
  isPublic: z.boolean(),
  // Null for public rooms; populated for private rooms when the viewer is a member.
  joinCode: z.string().nullable(),
  creatorId: UuidSchema.nullable(),
  createdAt: TimestampSchema,
});
export type ChatRoom = z.infer<typeof ChatRoomSchema>;

export const ChatRoomMemberSchema = z.object({
  userId: UuidSchema,
  role: ChatRoomRoleSchema,
  joinedAt: TimestampSchema,
  username: z.string().nullable(),
});
export type ChatRoomMember = z.infer<typeof ChatRoomMemberSchema>;

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

const RoomIdInput = z.object({ roomId: UuidSchema });
const RoomUserInput = z.object({ roomId: UuidSchema, userId: UuidSchema });
const ChatJoinCodeSchema = z.string().trim().min(1).max(JOIN_CODE_INPUT_MAX_LENGTH);

export const chatContract = {
  listRooms: oc.route({ method: 'GET', path: '/chat/rooms' }).output(z.array(ChatRoomSchema)),

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

  leaveRoom: oc
    .route({ method: 'POST', path: '/chat/rooms/{roomId}/leave' })
    .input(RoomIdInput)
    .output(z.object({ success: z.literal(true) })),

  getRoom: oc
    .route({ method: 'GET', path: '/chat/rooms/{roomId}' })
    .input(RoomIdInput)
    .output(ChatRoomSchema),

  kickMember: oc
    .route({ method: 'POST', path: '/chat/rooms/{roomId}/kick' })
    .input(RoomUserInput)
    .output(z.object({ success: z.literal(true) })),

  banMember: oc
    .route({ method: 'POST', path: '/chat/rooms/{roomId}/ban' })
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
        sortBy: AdminRoomSortBySchema,
        sortOrder: SortOrderSchema.default('desc'),
      }),
    )
    .output(paginated(ChatRoomSchema)),

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
};

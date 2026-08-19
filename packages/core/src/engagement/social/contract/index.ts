import { oc } from '@orpc/contract';
import * as z from 'zod';
import { TimestampSchema, UuidSchema } from '@openora/core/contracts';
import { PageQuerySchema, paginated } from '@openora/core/contracts/kit';

// Canonical request/response shapes for the Social module. This is the
// single source of truth - the router validates against it, live OpenAPI + the typed
// client are emitted from it. Derive related shapes with .pick()/.omit()/.extend()
// rather than re-typing fields. Promote anything shared across domains to
// @openora/core/contracts. This dir is isomorphic: Zod + @openora/core/contracts only.

export const SendFriendRequestInputSchema = z.object({
  targetUserId: UuidSchema,
});
export type SendFriendRequestInput = z.infer<typeof SendFriendRequestInputSchema>;

export const FriendshipSchema = z.object({
  id: UuidSchema,
  requesterId: UuidSchema,
  addresseeId: UuidSchema,
  createdAt: TimestampSchema,
  acceptedAt: TimestampSchema.nullable(),
  refusedAt: TimestampSchema.nullable(),
});
export type Friendship = z.infer<typeof FriendshipSchema>;

// Per-target relationship state for a batch lookup (eg rendering a friends-list /
// player-search page without one request per row). `unavailable` covers every case
// the caller must never be able to distinguish from "target doesn't exist" - a
// missing/suspended/closed player, or a target who has blocked the caller.
export const RELATIONSHIP_STATUSES = [
  'none',
  'pending_outgoing',
  'pending_incoming',
  'friends',
  'refused',
  'blocked_by_me',
  'unavailable',
] as const;
export const RelationshipStatusSchema = z.enum(RELATIONSHIP_STATUSES);
export type RelationshipStatus = z.infer<typeof RelationshipStatusSchema>;

export const GetRelationshipsInputSchema = z.object({
  userIds: z.array(UuidSchema).min(1).max(100),
});
export type GetRelationshipsInput = z.infer<typeof GetRelationshipsInputSchema>;

export const RelationshipSchema = z.object({
  userId: UuidSchema,
  status: RelationshipStatusSchema,
  friendshipId: UuidSchema.nullable(),
  canSendRequest: z.boolean(),
});
export type Relationship = z.infer<typeof RelationshipSchema>;

export const FriendListEntrySchema = z.object({
  userId: UuidSchema,
  friendshipId: UuidSchema,
  username: z.string(),
  status: z.enum(['online', 'offline']),
  lastSeenAt: TimestampSchema.nullable(),
  isIgnored: z.boolean(),
});
export type FriendListEntry = z.infer<typeof FriendListEntrySchema>;

export const RemoveFriendInputSchema = z.object({
  targetUserId: UuidSchema,
});
export type RemoveFriendInput = z.infer<typeof RemoveFriendInputSchema>;

export const FRIEND_REQUEST_DIRECTIONS = ['incoming', 'outgoing'] as const;
export const FriendRequestDirectionSchema = z.enum(FRIEND_REQUEST_DIRECTIONS);
export type FriendRequestDirection = z.infer<typeof FriendRequestDirectionSchema>;

export const ListFriendRequestsInputSchema = z.object({
  ...PageQuerySchema.shape,
  direction: FriendRequestDirectionSchema,
});
export type ListFriendRequestsInput = z.infer<typeof ListFriendRequestsInputSchema>;

export const FriendRequestEntrySchema = z.object({
  friendshipId: UuidSchema,
  userId: UuidSchema,
  displayName: z.string(),
  direction: FriendRequestDirectionSchema,
  createdAt: TimestampSchema,
  mutualFriendsCount: z.number().int().min(0).nullable(),
});
export type FriendRequestEntry = z.infer<typeof FriendRequestEntrySchema>;

export const FriendRequestIdInputSchema = z.object({
  friendshipId: UuidSchema,
});
export type FriendRequestIdInput = z.infer<typeof FriendRequestIdInputSchema>;

export const socialContract = {
  sendFriendRequest: oc
    .route({ method: 'POST', path: '/social/friend-requests' })
    .input(SendFriendRequestInputSchema)
    .output(FriendshipSchema),

  // POST is deliberate - this is a batch lookup, not a single-resource GET.
  getRelationships: oc
    .route({ method: 'POST', path: '/social/relationships' })
    .input(GetRelationshipsInputSchema)
    .output(z.array(RelationshipSchema)),

  listFriends: oc
    .route({ method: 'GET', path: '/social/friends' })
    .input(PageQuerySchema)
    .output(paginated(FriendListEntrySchema)),

  removeFriend: oc
    .route({ method: 'DELETE', path: '/social/friends/{targetUserId}' })
    .input(RemoveFriendInputSchema)
    .output(z.object({ success: z.literal(true) })),

  listFriendRequests: oc
    .route({ method: 'GET', path: '/social/friend-requests' })
    .input(ListFriendRequestsInputSchema)
    .output(paginated(FriendRequestEntrySchema)),

  acceptFriendRequest: oc
    .route({ method: 'POST', path: '/social/friend-requests/{friendshipId}/accept' })
    .input(FriendRequestIdInputSchema)
    .output(FriendshipSchema),

  declineFriendRequest: oc
    .route({ method: 'POST', path: '/social/friend-requests/{friendshipId}/decline' })
    .input(FriendRequestIdInputSchema)
    .output(z.object({ success: z.literal(true) })),

  cancelFriendRequest: oc
    .route({ method: 'DELETE', path: '/social/friend-requests/{friendshipId}' })
    .input(FriendRequestIdInputSchema)
    .output(z.object({ success: z.literal(true) })),
};

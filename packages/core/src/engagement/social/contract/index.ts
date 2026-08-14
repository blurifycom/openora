import { oc } from '@orpc/contract';
import * as z from 'zod';
import { TimestampSchema, UuidSchema } from '@openora/core/contracts';

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
};

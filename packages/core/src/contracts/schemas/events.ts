import * as z from 'zod';
import { UuidSchema } from './common.js';

const iamRoleEventBase = z.object({ roleId: UuidSchema, actorId: UuidSchema });
const permissionLevelEntries = z.array(z.object({ resource: z.string(), level: z.string() }));

export const domainEventSchemas = {
  'identity.user.registered': z.object({ userId: UuidSchema }),
  'identity.user.login': z.object({ userId: UuidSchema }),
  'identity.user.logout': z.object({ userId: UuidSchema }),
  'identity.2fa.enabled': z.object({ userId: UuidSchema }),
  'identity.2fa.disabled': z.object({ userId: UuidSchema }),
  'identity.password.reset': z.object({ userId: UuidSchema }),
  'identity.email.verified': z.object({ userId: UuidSchema }),
  'identity.profile.updated': z.object({ userId: UuidSchema }),

  // An admin toggled a user's active status (the only user-lifecycle flow today;
  // users are deactivated, never hard-deleted). userId = subject, actorId = the
  // admin who acted (for a complete audit trail).
  'identity.user.deactivated': z.object({ userId: UuidSchema, actorId: UuidSchema }),
  'identity.user.reactivated': z.object({ userId: UuidSchema, actorId: UuidSchema }),

  'wallet.deposit.completed': z.object({
    userId: UuidSchema,
    amount: z.number(),
    currency: z.string(),
    transactionId: UuidSchema,
  }),
  'wallet.withdrawal.completed': z.object({
    userId: UuidSchema,
    amount: z.number(),
    currency: z.string(),
    transactionId: UuidSchema,
  }),

  'gaming.round.started': z.object({
    roundId: UuidSchema,
    gameId: UuidSchema,
    userId: UuidSchema,
    currency: z.string(),
  }),
  'gaming.round.ended': z.object({ roundId: UuidSchema, userId: UuidSchema }),

  'bonus.claimed': z.object({
    userId: UuidSchema,
    bonusId: UuidSchema,
    userBonusId: UuidSchema,
  }),

  'chat.message.sent': z.object({
    messageId: UuidSchema,
    // null for global-chat messages (no room); a room id otherwise.
    roomId: UuidSchema.nullable(),
    userId: UuidSchema,
  }),

  // A player muted/unmuted another player's messages for themselves (ABC-45 AC11).
  'chat.user.blocked': z.object({ blockerId: UuidSchema, blockedId: UuidSchema }),
  'chat.user.unblocked': z.object({ blockerId: UuidSchema, blockedId: UuidSchema }),

  // An admin added or changed a geo (country) rule (regulatory). `actorId` is the
  // acting admin so the audit log can attribute the mutation.
  'compliance.geo-rule.added': z.object({
    countryCode: z.string(),
    action: z.string(),
    actorId: UuidSchema.optional(),
  }),

  'compliance.limit.upserted': z.object({ userId: UuidSchema, limitId: UuidSchema }),
  'compliance.limit.removed': z.object({ userId: UuidSchema, limitId: UuidSchema }),

  // An admin changed a player's KYC status (player-management update). userId =
  // subject player, actorId = the admin who acted; before/after status records the
  // transition for the audit log.
  'compliance.kyc.updated': z.object({
    userId: UuidSchema,
    actorId: UuidSchema,
    status: z.string(),
    previousStatus: z.string(),
  }),

  'notifications.created': z.object({ notificationId: UuidSchema, userId: UuidSchema }),

  'cms.page.published': z.object({ pageId: UuidSchema, slug: z.string() }),

  // An admin triggered a game-catalogue sync. `actorId` is the acting admin (the
  // envelope carries no caller) so the audit log can attribute the mutation.
  'aggregator.sync.completed': z.object({
    synced: z.number(),
    failed: z.number(),
    actorId: UuidSchema.optional(),
  }),
  'aggregator.callback.received': z.object({ provider: z.string(), event: z.string() }),

  'leaderboard.score.recorded': z.object({
    userId: UuidSchema,
    metric: z.string(),
    amount: z.number(),
  }),
  'leaderboard.reset': z.object({
    metric: z.string(),
    period: z.string(),
  }),

  'sportsbook.odds.updated': z.object({
    eventId: UuidSchema,
    selectionId: UuidSchema,
    odds: z.number(),
  }),
  'sportsbook.bet.placed': z.object({
    userId: UuidSchema,
    betId: UuidSchema,
    selectionId: UuidSchema,
    stake: z.number(),
  }),

  // Emitted when an admin invitation token is accepted. The consumer (identity
  // module or an overlay) provisions the user account and completes the role
  // assignment by resolving the userId from the email.
  'iam.invitation.accepted': z.object({
    email: z.string(),
    roleId: UuidSchema,
    invitationId: UuidSchema,
  }),

  // Backoffice RBAC mutations. The envelope does NOT carry the
  // caller, so every payload carries an explicit `actorId` (the admin who acted)
  // for the audit trail. `before`/`after` carry the level matrix for permission
  // changes so the audit log records the transition.
  'iam.role.created': iamRoleEventBase.extend({
    name: z.string(),
  }),
  'iam.role.updated': iamRoleEventBase.extend({
    name: z.string().optional(),
  }),
  'iam.role.deleted': iamRoleEventBase,
  'iam.role.permissions.changed': iamRoleEventBase.extend({
    before: permissionLevelEntries,
    after: permissionLevelEntries,
  }),
  'iam.role.assigned': iamRoleEventBase.extend({ userId: UuidSchema }),
  'iam.role.revoked': iamRoleEventBase.extend({ userId: UuidSchema }),
} as const;

export type DomainEventName = keyof typeof domainEventSchemas;
export type DomainEventPayload<K extends DomainEventName> = z.infer<(typeof domainEventSchemas)[K]>;

// Bump an entry only when its payload shape changes in a non-additive way, in the SAME commit
// that edits the schema above. Events not listed default to version 1.
export const domainEventVersions: Partial<Record<DomainEventName, number>> = {
  // 'wallet.deposit.completed': 2,  // example: bumped when `fee` was added
};

export function getEventVersion(event: string): number {
  return domainEventVersions[event as DomainEventName] ?? 1;
}

/** Returns every cross-module topic and its current schema version for broker provisioning and producer/consumer agreement checks. */
export function eventCatalog(): ReadonlyArray<{ topic: DomainEventName; version: number }> {
  return (Object.keys(domainEventSchemas) as DomainEventName[]).map((topic) => ({
    topic,
    version: getEventVersion(topic),
  }));
}

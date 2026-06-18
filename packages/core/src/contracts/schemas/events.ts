import * as z from 'zod';

const iamRoleEventBase = z.object({ roleId: z.string(), actorId: z.string() });
const permissionLevelEntries = z.array(z.object({ resource: z.string(), level: z.string() }));

export const domainEventSchemas = {
  'identity.user.registered': z.object({ userId: z.uuid() }),
  'identity.user.login': z.object({ userId: z.uuid() }),
  'identity.user.logout': z.object({ userId: z.uuid() }),
  'identity.2fa.enabled': z.object({ userId: z.uuid() }),
  'identity.2fa.disabled': z.object({ userId: z.uuid() }),
  'identity.password.reset': z.object({ userId: z.uuid() }),
  'identity.email.verified': z.object({ userId: z.uuid() }),
  'identity.profile.updated': z.object({ userId: z.uuid() }),

  'wallet.deposit.completed': z.object({
    userId: z.uuid(),
    amount: z.number(),
    currency: z.string(),
    transactionId: z.string(),
  }),
  'wallet.withdrawal.completed': z.object({
    userId: z.uuid(),
    amount: z.number(),
    currency: z.string(),
    transactionId: z.string(),
  }),

  'gaming.round.started': z.object({
    roundId: z.string(),
    gameId: z.string(),
    userId: z.uuid(),
    currency: z.string(),
  }),
  'gaming.round.ended': z.object({ roundId: z.string(), userId: z.uuid() }),

  'bonus.claimed': z.object({
    userId: z.uuid(),
    bonusId: z.string(),
    userBonusId: z.string(),
  }),

  'chat.message.sent': z.object({
    messageId: z.string(),
    roomId: z.string(),
    userId: z.uuid(),
  }),

  'compliance.limit.upserted': z.object({ userId: z.uuid(), limitId: z.string() }),
  'compliance.limit.removed': z.object({ userId: z.uuid(), limitId: z.string() }),

  // An admin changed a player's KYC status (player-management update). Carries the
  // subject player + the before/after status so the audit log records the transition.
  'compliance.kyc.updated': z.object({
    userId: z.uuid(),
    status: z.string(),
    previousStatus: z.string(),
  }),

  'notifications.created': z.object({ notificationId: z.string(), userId: z.uuid() }),

  'cms.page.published': z.object({ pageId: z.string(), slug: z.string() }),

  'aggregator.sync.completed': z.object({
    synced: z.number(),
    failed: z.number(),
  }),
  'aggregator.callback.received': z.object({ provider: z.string(), event: z.string() }),

  'leaderboard.score.recorded': z.object({
    userId: z.uuid(),
    metric: z.string(),
    amount: z.number(),
  }),
  'leaderboard.reset': z.object({
    metric: z.string(),
    period: z.string(),
  }),

  'sportsbook.odds.updated': z.object({
    eventId: z.string(),
    selectionId: z.string(),
    odds: z.number(),
  }),
  'sportsbook.bet.placed': z.object({
    userId: z.uuid(),
    betId: z.string(),
    selectionId: z.string(),
    stake: z.number(),
  }),

  // Emitted when an admin invitation token is accepted. The consumer (identity
  // module or an overlay) provisions the user account and completes the role
  // assignment by resolving the userId from the email.
  'iam.invitation.accepted': z.object({
    email: z.string(),
    roleId: z.string(),
    invitationId: z.string(),
  }),

  // Backoffice RBAC mutations. The envelope does NOT carry the
  // caller, so every payload carries an explicit `actorId` (the admin who acted)
  // for the audit trail. `before`/`after` carry the level matrix for permission
  // changes so the audit log records the transition.
  'iam.role.created': iamRoleEventBase.extend({
    name: z.string(),
    description: z.string().optional(),
  }),
  'iam.role.updated': iamRoleEventBase.extend({
    name: z.string().optional(),
    description: z.string().nullable().optional(),
  }),
  'iam.role.deleted': iamRoleEventBase,
  'iam.role.permissions.changed': iamRoleEventBase.extend({
    before: permissionLevelEntries,
    after: permissionLevelEntries,
  }),
  'iam.role.assigned': iamRoleEventBase.extend({ userId: z.string() }),
  'iam.role.revoked': iamRoleEventBase.extend({ userId: z.string() }),
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

import * as z from 'zod';
import { TimestampSchema, UuidSchema } from './common.js';
import {
  GeoRuleActionSchema,
  LimitTypeSchema,
  LimitPeriodSchema,
  ExclusionKindSchema,
} from './compliance.js';
import { LeaderboardMetricSchema, LeaderboardPeriodSchema } from './engagement.js';
import { CurrencyCodeSchema, CountryCodeSchema } from './igaming-config.js';
import { PermissionLevelSchema } from './iam.js';
import { KycStatusSchema } from './player.js';

const iamRoleEventBase = z.object({ roleId: UuidSchema, actorId: UuidSchema });
const permissionLevelEntries = z.array(
  z.object({ resource: z.string(), level: PermissionLevelSchema }),
);

// Optional request-origin metadata shared by auth events; both fields may be absent.
const authContextBase = z.object({
  ip: z.string().nullable().optional(),
  userAgent: z.string().nullable().optional(),
});

// Shared shape for every wallet money-movement event.
const walletTxnBase = z.object({
  userId: UuidSchema,
  amount: z.number(),
  currency: CurrencyCodeSchema,
  transactionId: UuidSchema,
});

export const domainEventSchemas = {
  'identity.user.registered': z.object({ userId: UuidSchema }),
  'identity.user.login': authContextBase.extend({ userId: UuidSchema }),
  'identity.user.login.failed': authContextBase.extend({
    email: z.email(),
    reason: z.string().nullable().optional(),
  }),
  'identity.user.logout': z.object({ userId: UuidSchema }),
  'identity.user.lockout.triggered': authContextBase.extend({
    userId: UuidSchema,
    email: z.email(),
    lockoutUntil: TimestampSchema,
  }),
  'identity.user.unlocked': z.object({
    userId: UuidSchema,
    email: z.email(),
    actorId: UuidSchema,
    previousFailedAttempts: z.number().int().optional(),
    previousLockoutUntil: TimestampSchema.nullable().optional(),
  }),
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
  'identity.session.revoked': z.object({
    userId: UuidSchema,
    sessionToken: z.string(),
    actorId: UuidSchema.optional(),
  }),
  'identity.sessions.revoked_all': z.object({
    userId: UuidSchema,
    actorId: UuidSchema.optional(),
  }),
  'identity.user.unauthorized_access': authContextBase.extend({
    userId: UuidSchema,
    resource: z.string(),
    action: z.string(),
    role: z.string().optional(),
  }),

  'wallet.deposit.completed': walletTxnBase,
  'wallet.withdrawal.completed': walletTxnBase,
  // A player requested a withdrawal; funds are held (balance debited) and the
  // request enters the back-office approval queue as `pending`.
  'wallet.withdrawal.requested': walletTxnBase,
  // A payments admin approved a pending withdrawal; it moves to `processing` and
  // is sent to the PSP/Fireblocks rail. `adminId` is the acting reviewer.
  'wallet.withdrawal.approved': walletTxnBase.extend({ adminId: UuidSchema }),
  // A payments admin rejected a pending withdrawal; held funds are returned to the
  // player balance. `adminId` is the acting reviewer; `reason` is mandatory.
  'wallet.withdrawal.rejected': walletTxnBase.extend({
    adminId: UuidSchema,
    reason: z.string(),
  }),
  // An approved withdrawal failed at the PSP/Fireblocks rail; the held funds were
  // returned to the player balance and the transaction moved to `failed`.
  'wallet.withdrawal.failed': walletTxnBase.extend({ adminId: UuidSchema }),

  'gaming.round.started': z.object({
    roundId: UuidSchema,
    gameId: UuidSchema,
    userId: UuidSchema,
    currency: CurrencyCodeSchema,
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
    countryCode: CountryCodeSchema,
    action: GeoRuleActionSchema,
    actorId: UuidSchema.optional(),
  }),

  'compliance.limit.upserted': z.object({ userId: UuidSchema, limitId: UuidSchema }),
  'compliance.limit.removed': z.object({ userId: UuidSchema, limitId: UuidSchema }),

  // Responsible-Gambling admin actions. `userId` = the subject player, `actorId` =
  // the acting admin (the envelope carries no caller, so it is explicit for the audit
  // trail). login_blocked is system-driven (no actor) and a failure outcome.
  'rg.limit.set': z.object({
    userId: UuidSchema,
    actorId: UuidSchema,
    limitId: UuidSchema,
    type: LimitTypeSchema,
    period: LimitPeriodSchema,
    amount: z.number(),
    // null when this is the first limit of that (type, period).
    previousAmount: z.number().nullable(),
  }),
  'rg.cooling_off.activated': z.object({
    userId: UuidSchema,
    actorId: UuidSchema,
    exclusionId: UuidSchema,
    expiresAt: TimestampSchema,
    reason: z.string(),
  }),
  'rg.self_exclusion.activated': z.object({
    userId: UuidSchema,
    actorId: UuidSchema,
    exclusionId: UuidSchema,
    permanent: z.boolean(),
    expiresAt: TimestampSchema.nullable(),
    reason: z.string(),
  }),
  'rg.self_exclusion.lifted': z.object({
    userId: UuidSchema,
    actorId: UuidSchema,
    exclusionId: UuidSchema,
    kind: ExclusionKindSchema,
    reason: z.string(),
  }),
  'rg.exclusion.login_blocked': z.object({
    userId: UuidSchema,
    ip: z.string().nullable().optional(),
    userAgent: z.string().nullable().optional(),
  }),

  // A player's KYC status changed. userId = subject player; actorId = the admin who
  // acted, or null for system-driven changes (vendor decision, webhook, threshold
  // re-KYC). before/after status records the transition for the audit log.
  'compliance.kyc.updated': z.object({
    userId: UuidSchema,
    actorId: UuidSchema.nullable(),
    status: KycStatusSchema,
    previousStatus: KycStatusSchema,
  }),

  // A player submitted KYC documents; a verification record was created and sent to
  // the provider. userId = the submitting player; referenceId = the provider reference.
  'compliance.kyc.submitted': z.object({
    userId: UuidSchema,
    referenceId: z.string(),
    provider: z.string(),
  }),

  // A threshold-triggered re-KYC flipped a verified player to resubmission_requested.
  // System-driven (no admin actor); reason records the metric that crossed.
  'compliance.kyc.reverify_required': z.object({
    userId: UuidSchema,
    reason: z.string(),
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
    metric: LeaderboardMetricSchema,
    amount: z.number(),
  }),
  'leaderboard.reset': z.object({
    metric: LeaderboardMetricSchema,
    period: LeaderboardPeriodSchema,
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
    email: z.email(),
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
  // v3: actorId is nullable - null marks a system-driven flip (vendor/webhook/reverify),
  // which the audit writer records as actorType 'system'.
  'compliance.kyc.updated': 3,
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

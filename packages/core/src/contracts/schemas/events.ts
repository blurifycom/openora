import * as z from 'zod';
import { MoneyAmountSchema, TimestampSchema, UuidSchema } from './common.js';
import {
  GeoRuleActionSchema,
  LimitTypeSchema,
  LimitPeriodSchema,
  ExclusionKindSchema,
} from './compliance.js';
import { TagKeySchema } from './tag.js';
import { CurrencyCodeSchema, CountryCodeSchema } from './igaming-config.js';
import { PermissionLevelSchema } from './iam.js';
import { KycStatusSchema } from './player.js';

// Optional request-origin metadata shared by HTTP-triggered events; both fields may be absent.
const authContextBase = z.object({
  ip: z.string().nullable().optional(),
  userAgent: z.string().nullable().optional(),
});

const iamRoleEventBase = z
  .object({ roleId: UuidSchema, actorId: UuidSchema })
  .merge(authContextBase);
const cmsPageEventBase = z
  .object({ pageId: UuidSchema, actorId: UuidSchema })
  .merge(authContextBase);
const cmsBannerEventBase = z
  .object({ bannerId: UuidSchema, actorId: UuidSchema })
  .merge(authContextBase);
const actorReasonBase = z.object({ actorId: UuidSchema, reason: z.string() });
const tagPlayerEventBase = actorReasonBase
  .extend({ playerId: UuidSchema, tagKey: TagKeySchema })
  .merge(authContextBase);
const permissionLevelEntries = z.array(
  z.object({ resource: z.string(), level: PermissionLevelSchema }),
);

// Shared shape for every wallet money-movement event. Exact decimal string + currency.
const walletTxnBase = z.object({
  userId: UuidSchema,
  amount: MoneyAmountSchema,
  currency: CurrencyCodeSchema,
  transactionId: UuidSchema,
});

export const domainEventSchemas = {
  'identity.user.registered': authContextBase.extend({ userId: UuidSchema }),
  'identity.user.login': authContextBase.extend({ userId: UuidSchema }),
  'identity.user.login.failed': authContextBase.extend({
    email: z.email(),
    reason: z.string().nullable().optional(),
    attemptsRemaining: z.number().int().optional(),
  }),
  'identity.user.logout': authContextBase.extend({ userId: UuidSchema }),
  'identity.user.phone_login': authContextBase.extend({
    userId: UuidSchema,
    method: z.literal('phone'),
  }),
  'identity.phone_otp.requested': authContextBase.extend({ userId: UuidSchema }),
  'identity.phone_otp.cancelled': authContextBase.extend({
    userId: UuidSchema,
    reason: z.enum(['max_attempts', 'new_otp_requested']),
  }),
  'identity.user.lockout.triggered': authContextBase.extend({
    userId: UuidSchema,
    email: z.email(),
    lockoutUntil: TimestampSchema,
  }),
  'identity.user.unlocked': authContextBase.extend({
    userId: UuidSchema,
    email: z.email(),
    actorId: UuidSchema,
    previousFailedAttempts: z.number().int().optional(),
    previousLockoutUntil: TimestampSchema.nullable().optional(),
  }),
  'identity.2fa.enabled': authContextBase.extend({ userId: UuidSchema }),
  'identity.2fa.disabled': authContextBase.extend({ userId: UuidSchema }),
  'identity.password.reset': authContextBase.extend({ userId: UuidSchema }),
  'identity.email.verified': authContextBase.extend({ userId: UuidSchema }),
  'identity.profile.updated': authContextBase.extend({ userId: UuidSchema }),
  // An admin toggled a user's active status (the only user-lifecycle flow today;
  // users are deactivated, never hard-deleted). userId = subject, actorId = the
  // admin who acted (for a complete audit trail).
  'identity.user.deactivated': authContextBase.extend({ userId: UuidSchema, actorId: UuidSchema }),
  'identity.user.reactivated': authContextBase.extend({ userId: UuidSchema, actorId: UuidSchema }),
  'identity.session.revoked': authContextBase.extend({
    userId: UuidSchema,
    sessionId: UuidSchema,
    actorId: UuidSchema.optional(),
  }),
  'identity.sessions.revoked_all': authContextBase.extend({
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
  'wallet.withdrawal.requested': walletTxnBase.merge(authContextBase),
  // A payments admin approved a pending withdrawal; it moves to `processing` and
  // is sent to the PSP/Fireblocks rail. `adminId` is the acting reviewer.
  'wallet.withdrawal.approved': walletTxnBase
    .extend({ adminId: UuidSchema })
    .merge(authContextBase),
  // A payments admin rejected a pending withdrawal; held funds are returned to the
  // player balance. `adminId` is the acting reviewer; `reason` is mandatory.
  'wallet.withdrawal.rejected': walletTxnBase
    .extend({ adminId: UuidSchema, reason: z.string() })
    .merge(authContextBase),
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

  'chat.message.sent': z.object({
    messageId: UuidSchema,
    // null for global-chat messages (no room); a room id otherwise.
    roomId: UuidSchema.nullable(),
    userId: UuidSchema,
  }),

  // A player muted/unmuted another player's messages for themselves (ABC-45 AC11).
  'chat.user.blocked': authContextBase.extend({ blockerId: UuidSchema, blockedId: UuidSchema }),
  'chat.user.unblocked': authContextBase.extend({ blockerId: UuidSchema, blockedId: UuidSchema }),

  // Admin room CRUD (actorId = acting admin UUID).
  'chat.room.created': authContextBase.extend({
    roomId: UuidSchema,
    name: z.string(),
    slug: z.string(),
    category: z.string(),
    actorId: UuidSchema.optional(),
  }),
  'chat.room.deleted': authContextBase.extend({
    roomId: UuidSchema,
    actorId: UuidSchema.optional(),
    before: z.object({ name: z.string(), slug: z.string(), category: z.string() }),
  }),
  'chat.room.updated': authContextBase.extend({
    roomId: UuidSchema,
    actorId: UuidSchema.optional(),
    before: z.object({ name: z.string(), slug: z.string(), category: z.string() }),
    after: z.object({ name: z.string(), slug: z.string(), category: z.string() }),
  }),

  // Private room lifecycle: creation and member membership changes.
  'chat.private_room.created': authContextBase.extend({
    roomId: UuidSchema,
    creatorId: UuidSchema,
  }),
  'chat.room.member.joined': authContextBase.extend({ roomId: UuidSchema, userId: UuidSchema }),
  'chat.room.member.left': authContextBase.extend({ roomId: UuidSchema, userId: UuidSchema }),
  'chat.room.member.kicked': authContextBase.extend({
    roomId: UuidSchema,
    userId: UuidSchema,
    kickedBy: UuidSchema,
  }),
  'chat.room.member.banned': authContextBase.extend({
    roomId: UuidSchema,
    userId: UuidSchema,
    bannedBy: UuidSchema,
  }),

  // An admin added or changed a geo (country) rule (regulatory). `actorId` is the
  // acting admin so the audit log can attribute the mutation.
  'compliance.geo-rule.added': authContextBase.extend({
    countryCode: CountryCodeSchema,
    action: GeoRuleActionSchema,
    actorId: UuidSchema.optional(),
  }),

  'compliance.limit.upserted': authContextBase.extend({ userId: UuidSchema, limitId: UuidSchema }),
  'compliance.limit.removed': authContextBase.extend({ userId: UuidSchema, limitId: UuidSchema }),

  // Responsible-Gambling admin actions. `userId` = the subject player, `actorId` =
  // the acting admin (the envelope carries no caller, so it is explicit for the audit
  // trail). login_blocked is system-driven (no actor) and a failure outcome.
  // amount/minutes are polymorphic by `type` (see compliance/contract/limits.ts):
  // money-type limits carry amount (minutes null), the session-type limit
  // carries minutes (amount null). previous* mirrors the prior row's value, null
  // when this is the first limit of that (type, period).
  'rg.limit.set': authContextBase.extend({
    userId: UuidSchema,
    actorId: UuidSchema,
    limitId: UuidSchema,
    type: LimitTypeSchema,
    period: LimitPeriodSchema,
    amount: MoneyAmountSchema.nullable(),
    minutes: z.number().int().nullable(),
    previousAmount: MoneyAmountSchema.nullable(),
    previousMinutes: z.number().int().nullable(),
  }),
  'rg.cooling_off.activated': actorReasonBase
    .extend({ userId: UuidSchema, exclusionId: UuidSchema, expiresAt: TimestampSchema })
    .merge(authContextBase),
  'rg.self_exclusion.activated': actorReasonBase
    .extend({
      userId: UuidSchema,
      exclusionId: UuidSchema,
      isPermanent: z.boolean(),
      expiresAt: TimestampSchema.nullable(),
    })
    .merge(authContextBase),
  'rg.self_exclusion.lifted': actorReasonBase
    .extend({ userId: UuidSchema, exclusionId: UuidSchema, kind: ExclusionKindSchema })
    .merge(authContextBase),
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
  'compliance.kyc.submitted': authContextBase.extend({
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

  'cms.page.published': authContextBase.extend({ pageId: UuidSchema, slug: z.string() }),
  'cms.page.created': cmsPageEventBase,
  'cms.page.updated': cmsPageEventBase,
  'cms.page.deleted': cmsPageEventBase,
  'cms.banner.created': cmsBannerEventBase,
  'cms.banner.updated': cmsBannerEventBase,
  'cms.banner.deleted': cmsBannerEventBase,

  // Emitted when an admin invitation token is accepted. The consumer (identity
  // module or an overlay) provisions the user account and completes the role
  // assignment by resolving the userId from the email.
  'iam.invitation.accepted': authContextBase.extend({
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

  // Emitted after any tag is assigned to or removed from a player (both automated and manual).
  // actorId is the user performing the action (SYSTEM_ACTOR_ID for automated ops).
  'tag.player.assigned': tagPlayerEventBase,
  'tag.player.removed': tagPlayerEventBase,
  // Emitted after an admin creates or updates a tag rule configuration.
  'tag.rule.upserted': z.object({
    tagKey: TagKeySchema,
    actorId: UuidSchema,
    after: z.record(z.string(), z.unknown()),
  }),
} as const;

export type DomainEventName = keyof typeof domainEventSchemas;
export type DomainEventPayload<K extends DomainEventName> = z.infer<(typeof domainEventSchemas)[K]>;

// Bump an entry only when its payload shape changes in a non-additive way, in the SAME commit
// that edits the schema above. Events not listed default to version 1.
export const domainEventVersions: Partial<Record<DomainEventName, number>> = {
  // v3: actorId is nullable - null marks a system-driven flip (vendor/webhook/reverify),
  // which the audit writer records as actorType 'system'.
  'compliance.kyc.updated': 3,
  // v2: sessionToken (the raw bearer credential) replaced with sessionId - the token
  // must never be persisted to the audit log or handed back to any caller.
  'identity.session.revoked': 2,
  // v2: exact decimal-string amount (+ currency), never a JS number.
  'wallet.deposit.completed': 2,
  'wallet.withdrawal.completed': 2,
  'wallet.withdrawal.requested': 2,
  'wallet.withdrawal.approved': 2,
  'wallet.withdrawal.rejected': 2,
  'wallet.withdrawal.failed': 2,
  // v2: amount/previousAmount (decimal string) + minutes/previousMinutes polymorphic
  // pair (money limit vs session-time limit), never a JS number.
  'rg.limit.set': 2,
  // v2: permanent renamed to isPermanent (non-predicate boolean naming rule).
  'rg.self_exclusion.activated': 2,
};

export function getEventVersion(event: string): number {
  return domainEventVersions[event as DomainEventName] ?? 1;
}

export const DOMAIN_EVENT_CATALOG = Object.keys(domainEventSchemas) as DomainEventName[];

/** Returns every cross-module topic and its current schema version for broker provisioning and producer/consumer agreement checks. */
export function eventCatalog(): ReadonlyArray<{ topic: DomainEventName; version: number }> {
  return DOMAIN_EVENT_CATALOG.map((topic) => ({
    topic,
    version: getEventVersion(topic),
  }));
}

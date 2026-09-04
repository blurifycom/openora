import * as z from 'zod';
import {
  ClientMetaSchema,
  CurrencyTickerSchema,
  MoneyAmountSchema,
  TimestampSchema,
  UuidSchema,
} from './common.js';
import {
  GeoRuleActionSchema,
  LimitTypeSchema,
  LimitPeriodSchema,
  LimitChangeKindSchema,
  RgInitiatorSchema,
  ExclusionKindSchema,
} from './compliance.js';
import { TagKeySchema } from './tag.js';
import { CountryCodeSchema } from './igaming-config.js';
import { PermissionLevelSchema } from './iam.js';
import { RegistrationFailureReasonSchema, UsernameSchema } from './identity.js';
import {
  KycStatusSchema,
  KycStatusSourceSchema,
  KycTierSchema,
  PlayerStatusSchema,
} from './player.js';

// Optional request-origin metadata shared by HTTP-triggered events; both fields may be absent.
const authContextBase = ClientMetaSchema.partial();

const iamRoleEventBase = z
  .object({ roleId: UuidSchema, actorId: UuidSchema })
  .extend(authContextBase.shape);
const cmsPageEventBase = z
  .object({ pageId: UuidSchema, actorId: UuidSchema })
  .extend(authContextBase.shape);
const cmsBannerConfigurationEventBase = z
  .object({ bannerConfigurationId: UuidSchema, actorId: UuidSchema })
  .extend(authContextBase.shape);
const cmsBannerImageEventBase = z
  .object({ bannerImageId: UuidSchema, bannerConfigurationId: UuidSchema, actorId: UuidSchema })
  .extend(authContextBase.shape);
const cmsBannerScheduleEventBase = z
  .object({
    bannerScheduleId: UuidSchema,
    bannerConfigurationId: UuidSchema,
    placement: z.string(),
    startsAt: TimestampSchema,
    endsAt: TimestampSchema,
    actorId: UuidSchema,
  })
  .extend(authContextBase.shape);
const cmsBannerScheduleUpdatedEvent = cmsBannerScheduleEventBase.extend({
  before: z.object({ endsAt: TimestampSchema }),
});
const actorReasonBase = z.object({ actorId: UuidSchema, reason: z.string() });
const tagPlayerEventBase = actorReasonBase
  .extend({ playerId: UuidSchema, tagKey: TagKeySchema })
  .extend(authContextBase.shape);
const permissionLevelEntries = z.array(
  z.object({ resource: z.string(), level: PermissionLevelSchema }),
);

// Shared shape for every wallet money-movement event. Exact decimal string + currency.
const walletTxnBase = z.object({
  userId: UuidSchema,
  amount: MoneyAmountSchema,
  currency: CurrencyTickerSchema,
  transactionId: UuidSchema,
});

const limitChangeBase = authContextBase.extend({
  userId: UuidSchema,
  playerId: UuidSchema.nullable(),
  limitId: UuidSchema,
  type: LimitTypeSchema,
  period: LimitPeriodSchema,
  kind: LimitChangeKindSchema,
  previousAmount: MoneyAmountSchema.nullable(),
  previousMinutes: z.number().int().nullable(),
  requestedAmount: MoneyAmountSchema.nullable(),
  requestedMinutes: z.number().int().nullable(),
});

export const KycStatusUpdatedSchema = z.object({
  userId: UuidSchema,
  playerId: UuidSchema.nullable(),
  actorId: UuidSchema.nullable(),
  status: KycStatusSchema,
  previousStatus: KycStatusSchema,
  reason: z.string().nullable(),
  source: KycStatusSourceSchema,
  // Forward-compatible (ADR-0016): every deployment binds RedisStreamsBroker (ADR-0030/
  // 0032), so a durable backlog survives a restart. A pre-tiering (v4) payload in that
  // backlog at rollout has no `tier` at all - everything WAS basic-only before tiering,
  // so default it rather than let safeParse silently drop the event.
  tier: KycTierSchema.default('basic'),
});

export const TWO_FACTOR_METHODS = ['totp', 'otp', 'backup_code', 'webauthn'] as const;
export const TwoFactorMethodSchema = z.enum(TWO_FACTOR_METHODS);
export type TwoFactorMethod = z.infer<typeof TwoFactorMethodSchema>;

export const domainEventSchemas = {
  'identity.user.registered': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    // The consent the player actually gave, carried so the audit trail holds it too -
    // the `player` row alone is current state, not a record of the act. Absent when the
    // consent write was discarded because a player row already existed.
    termsVersion: z.string().optional(),
    acceptedTerms: z.literal(true).optional(),
    acceptedAge: z.literal(true).optional(),
  }),
  // No `userId`: registration is unauthenticated, so the address is the only subject
  // there is - the same shape `identity.user.login.failed` settled on below.
  'identity.user.registration.failed': authContextBase.extend({
    email: z.email(),
    username: UsernameSchema.optional(),
    reason: RegistrationFailureReasonSchema,
  }),
  'identity.user.login': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
  }),
  'identity.user.login.failed': authContextBase.extend({
    email: z.email(),
    reason: z.string().nullable().optional(),
    attemptsRemaining: z.number().int().optional(),
  }),
  'identity.user.logout': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
  }),
  'identity.user.phone_login': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
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
    tier: z.number().int().positive().optional(),
    lockoutUntil: TimestampSchema,
  }),
  'identity.user.unlocked': authContextBase.extend({
    userId: UuidSchema,
    email: z.email(),
    actorId: UuidSchema,
    previousFailedAttempts: z.number().int().optional(),
    previousLockoutUntil: TimestampSchema.nullable().optional(),
  }),
  'identity.2fa.enabled': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    method: TwoFactorMethodSchema,
  }),
  'identity.2fa.disabled': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    method: TwoFactorMethodSchema,
  }),
  'identity.2fa.verified': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    method: TwoFactorMethodSchema,
    trustedDevice: z.boolean(),
  }),
  'identity.2fa.failed': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    method: TwoFactorMethodSchema,
    attemptsRemaining: z.number().int().nonnegative(),
  }),
  // The account's recovery credentials were replaced; every previously issued code is
  // dead from here on.
  'identity.2fa.backup_codes_regenerated': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
  }),
  // A Super Admin cleared someone else's second factor; the account is back to the
  // unenrolled state and must set one up before it reaches any admin route again.
  'identity.2fa.reset': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    actorId: UuidSchema,
    // Free-text justification the Super Admin gave when clearing the second factor.
    reason: z.string(),
  }),
  'identity.2fa.lockout.triggered': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    lockoutUntil: TimestampSchema,
  }),
  // An admin account reached an admin route without a second factor configured.
  'identity.2fa.enrollment_blocked': authContextBase.extend({
    userId: UuidSchema,
  }),
  // A session was used from a device or network that no longer matches the one it
  // was issued to; the session is revoked before this is emitted.
  'identity.session.fingerprint_mismatch': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    sessionId: UuidSchema,
    mismatch: z.enum(['user_agent', 'ip']),
  }),
  'identity.trusted_device.added': authContextBase.extend({
    userId: UuidSchema,
    deviceId: UuidSchema,
    label: z.string(),
    expiresAt: TimestampSchema,
  }),
  'identity.trusted_device.revoked': authContextBase.extend({
    userId: UuidSchema,
    deviceId: UuidSchema,
    // Absent when the guard itself forces the revoke (fingerprint mismatch) rather
    // than an admin or the device owner acting.
    actorId: UuidSchema.optional(),
  }),
  'identity.password.reset': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
  }),
  'identity.email.verified': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
  }),
  'identity.profile.updated': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
  }),
  // An admin toggled a user's active status (the only user-lifecycle flow today;
  // users are deactivated, never hard-deleted). userId = subject, actorId = the
  // admin who acted (for a complete audit trail).
  'identity.user.deactivated': authContextBase.extend({ userId: UuidSchema, actorId: UuidSchema }),
  'identity.user.reactivated': authContextBase.extend({ userId: UuidSchema, actorId: UuidSchema }),
  'identity.session.revoked': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    sessionId: UuidSchema,
    actorId: UuidSchema.optional(),
  }),
  'identity.sessions.revoked_all': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    actorId: UuidSchema.optional(),
  }),
  'identity.user.unauthorized_access': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    resource: z.string(),
    action: z.string(),
    role: z.string().optional(),
  }),
  // An admin triggered a password-reset OTP send on a player's behalf (backoffice
  // "send reset link" action). userId = subject player, actorId = the admin.
  'identity.password.admin_reset_requested': authContextBase.extend({
    userId: UuidSchema,
    email: z.email(),
    actorId: UuidSchema,
  }),

  'wallet.deposit.completed': walletTxnBase.extend({ playerId: UuidSchema.nullable() }),
  'wallet.withdrawal.completed': walletTxnBase.extend({ playerId: UuidSchema.nullable() }),
  // A player requested a withdrawal; funds are held (balance debited) and the
  // request enters the back-office approval queue as `pending`.
  'wallet.withdrawal.requested': walletTxnBase
    .extend({ playerId: UuidSchema.nullable() })
    .extend(authContextBase.shape),
  // A payments admin approved a pending withdrawal; it moves to `processing` and
  // is sent to the PSP/custody rail. `adminId` is the acting reviewer.
  'wallet.withdrawal.approved': walletTxnBase
    .extend({ adminId: UuidSchema })
    .extend(authContextBase.shape),
  // A payments admin rejected a pending withdrawal; held funds are returned to the
  // player balance. `adminId` is the acting reviewer; `reason` is mandatory.
  'wallet.withdrawal.rejected': walletTxnBase
    .extend({ adminId: UuidSchema, reason: z.string() })
    .extend(authContextBase.shape),
  // An approved withdrawal failed at the PSP/custody rail; the held funds were
  // returned to the player balance and the transaction moved to `failed`.
  'wallet.withdrawal.failed': walletTxnBase.extend({ adminId: UuidSchema }),
  // A super admin credited or debited a balance directly, outside the deposit and
  // withdrawal rails. Its own topic rather than a reuse of `wallet.deposit.completed`:
  // a correction is not a deposit, and reporting it as one would overstate deposits and
  // GGR. Subscribers that track balance movement must handle it or they see a balance
  // change with no event behind it.
  'wallet.manual_adjustment.created': walletTxnBase
    .extend({
      playerId: UuidSchema.nullable(),
      adminId: UuidSchema,
      direction: z.enum(['credit', 'debit']),
      reason: z.string(),
    })
    .extend(authContextBase.shape),
  // A reconciliation run's open-findings count exceeded the operator's configured
  // threshold. System-driven (no player/admin actor) - the resource is the run itself,
  // never a finding's payload (an address or tx hash must never reach the audit log
  // through this event - see docs/standards/audit.md).
  'wallet.reconciliation.alert': z.object({
    runId: UuidSchema,
    openFindings: z.number().int().nonnegative(),
    threshold: z.number().int().nonnegative(),
  }),

  'gaming.round.started': z.object({
    roundId: UuidSchema,
    gameId: UuidSchema,
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    currency: CurrencyTickerSchema,
  }),
  'gaming.round.ended': z.object({
    roundId: UuidSchema,
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
  }),

  'wallet.bonus_rollover.completed': z.object({
    userId: UuidSchema,
    creditId: UuidSchema,
    currency: CurrencyTickerSchema,
    creditedAmount: MoneyAmountSchema,
  }),

  'chat.message.sent': z.object({
    messageId: UuidSchema,
    // null for global-chat messages (no room); a room id otherwise.
    roomId: UuidSchema.nullable(),
    userId: UuidSchema,
  }),

  // A player muted/unmuted another player's messages for themselves (ABC-45 AC11).
  // actorPlayerId = the blocker/ignorer; playerId = the blocked/ignored subject (resourceId).
  'chat.user.blocked': authContextBase.extend({
    blockerId: UuidSchema,
    actorPlayerId: UuidSchema.nullable(),
    blockedId: UuidSchema,
    playerId: UuidSchema.nullable(),
  }),
  'chat.user.unblocked': authContextBase.extend({
    blockerId: UuidSchema,
    actorPlayerId: UuidSchema.nullable(),
    blockedId: UuidSchema,
    playerId: UuidSchema.nullable(),
  }),
  'chat.user.ignored': authContextBase.extend({
    ignorerId: UuidSchema,
    actorPlayerId: UuidSchema.nullable(),
    ignoredId: UuidSchema,
    playerId: UuidSchema.nullable(),
  }),
  'chat.user.unignored': authContextBase.extend({
    ignorerId: UuidSchema,
    actorPlayerId: UuidSchema.nullable(),
    ignoredId: UuidSchema,
    playerId: UuidSchema.nullable(),
  }),

  // Admin room CRUD (actorId = acting admin UUID).
  'chat.room.created': authContextBase.extend({
    roomId: UuidSchema,
    name: z.string(),
    slug: z.string(),
    category: z.string().nullable(),
    actorId: UuidSchema.optional(),
  }),
  'chat.room.deleted': authContextBase.extend({
    roomId: UuidSchema,
    actorId: UuidSchema.optional(),
    before: z.object({ name: z.string(), slug: z.string(), category: z.string().nullable() }),
  }),
  'chat.room.updated': authContextBase.extend({
    roomId: UuidSchema,
    actorId: UuidSchema.optional(),
    before: z.object({ name: z.string(), slug: z.string(), category: z.string().nullable() }),
    after: z.object({ name: z.string(), slug: z.string(), category: z.string().nullable() }),
  }),

  // Private room lifecycle: creation and member membership changes.
  'chat.private_room.created': authContextBase.extend({
    roomId: UuidSchema,
    creatorId: UuidSchema,
    playerId: UuidSchema.nullable(),
  }),
  'chat.private_room.deleted': authContextBase.extend({
    roomId: UuidSchema,
    creatorId: UuidSchema,
    playerId: UuidSchema.nullable(),
    before: z.object({ name: z.string(), slug: z.string(), category: z.string().nullable() }),
    after: z.object({ deletedAt: z.string() }),
  }),
  'chat.room.member.joined': authContextBase.extend({
    roomId: UuidSchema,
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
  }),
  'chat.room.member.left': authContextBase.extend({
    roomId: UuidSchema,
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
  }),
  'chat.room.member.kicked': authContextBase.extend({
    roomId: UuidSchema,
    userId: UuidSchema,
    kickedBy: UuidSchema,
    playerId: UuidSchema.nullable(),
  }),
  'chat.room.member.removed': authContextBase.extend({
    roomId: UuidSchema,
    userId: UuidSchema,
    removedBy: UuidSchema,
  }),
  // A room owner granted or revoked the moderator role. `role` is the member's new role and
  // `previousRole` the one it replaced - a permission change is only auditable with both.
  // `owner` never appears in either - ownership transfer is a separate flow. `playerId` is the
  // acting owner's, null when no player record backs them; `changedBy` always carries the raw
  // acting user id so the actor survives that case.
  'chat.room.member.role-changed': authContextBase.extend({
    roomId: UuidSchema,
    userId: UuidSchema,
    changedBy: UuidSchema,
    role: z.enum(['member', 'moderator']),
    previousRole: z.enum(['member', 'moderator']),
    playerId: UuidSchema.nullable(),
  }),
  'chat.room.member.banned': authContextBase.extend({
    roomId: UuidSchema,
    userId: UuidSchema,
    bannedBy: UuidSchema,
    playerId: UuidSchema.nullable(),
  }),

  'chat.room.ownership.transferred': authContextBase.extend({
    roomId: UuidSchema,
    roomName: z.string(),
    previousOwnerId: UuidSchema,
    newOwnerId: UuidSchema,
    reason: z.literal('account-closed'),
  }),
  'chat.room.scheduled_for_deletion': authContextBase.extend({
    roomId: UuidSchema,
    roomName: z.string(),
    previousOwnerId: UuidSchema,
    memberIds: z.array(UuidSchema),
    scheduledDeletionAt: TimestampSchema,
  }),
  'chat.room.deletion.cancelled': authContextBase.extend({
    roomId: UuidSchema,
    roomName: z.string(),
    ownerId: UuidSchema,
    memberIds: z.array(UuidSchema),
  }),
  'chat.private_room.purged': authContextBase.extend({
    roomId: UuidSchema,
    messageCount: z.number().int(),
  }),

  // An admin added or changed a geo (country) rule (regulatory). `actorId` is the
  // acting admin so the audit log can attribute the mutation.
  'compliance.geo-rule.added': authContextBase.extend({
    countryCode: CountryCodeSchema,
    action: GeoRuleActionSchema,
    actorId: UuidSchema.optional(),
  }),

  'compliance.limit.upserted': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    limitId: UuidSchema,
  }),
  'compliance.limit.removed': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    limitId: UuidSchema,
  }),

  // Responsible-Gambling admin actions. `userId` = the subject player, `actorId` =
  // the acting admin (the envelope carries no caller, so it is explicit for the audit
  // trail). login_blocked is system-driven (no actor) and a failure outcome.
  // amount/minutes are polymorphic by `type` (see compliance/contract/limits.ts):
  // money-type limits carry amount (minutes null), the session-type limit
  // carries minutes (amount null). previous* mirrors the prior row's value, null
  // when this is the first limit of that (type, period).
  'rg.limit.set': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    actorId: UuidSchema,
    limitId: UuidSchema,
    type: LimitTypeSchema,
    period: LimitPeriodSchema,
    amount: MoneyAmountSchema.nullable(),
    minutes: z.number().int().nullable(),
    previousAmount: MoneyAmountSchema.nullable(),
    previousMinutes: z.number().int().nullable(),
    initiatedBy: RgInitiatorSchema,
    reason: z.string().nullable(),
  }),
  'rg.limit.change_requested': limitChangeBase.extend({
    actorId: UuidSchema,
    effectiveAt: TimestampSchema,
    expiresAt: TimestampSchema,
    initiatedBy: RgInitiatorSchema,
  }),
  'rg.limit.change_confirmed': limitChangeBase.extend({
    actorId: UuidSchema,
    initiatedBy: RgInitiatorSchema,
  }),
  'rg.limit.change_cancelled': limitChangeBase.extend({
    actorId: UuidSchema,
    initiatedBy: RgInitiatorSchema,
  }),
  'rg.limit.change_expired': limitChangeBase.extend({ expiresAt: TimestampSchema }),
  'rg.cooling_off.activated': actorReasonBase
    .extend({
      userId: UuidSchema,
      playerId: UuidSchema.nullable(),
      exclusionId: UuidSchema,
      expiresAt: TimestampSchema,
      initiatedBy: RgInitiatorSchema,
    })
    .extend(authContextBase.shape),
  // durationMonths is the admin's chosen term, null when permanent - the regulatory
  // export reads the decision as made rather than re-deriving it from expiresAt.
  'rg.self_exclusion.activated': actorReasonBase
    .extend({
      userId: UuidSchema,
      playerId: UuidSchema.nullable(),
      exclusionId: UuidSchema,
      isPermanent: z.boolean(),
      durationMonths: z.number().int().nullable(),
      expiresAt: TimestampSchema.nullable(),
      initiatedBy: RgInitiatorSchema,
    })
    .extend(authContextBase.shape),
  'rg.self_exclusion.lifted': actorReasonBase
    .extend({
      userId: UuidSchema,
      playerId: UuidSchema.nullable(),
      exclusionId: UuidSchema,
      kind: ExclusionKindSchema,
    })
    .extend(authContextBase.shape),
  'rg.cooling_off.lifted': actorReasonBase
    .extend({ userId: UuidSchema, playerId: UuidSchema.nullable(), exclusionId: UuidSchema })
    .extend(authContextBase.shape),
  'rg.cooling_off.expired': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    exclusionId: UuidSchema,
    expiresAt: TimestampSchema,
  }),
  'rg.exclusion.login_blocked': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
  }),

  // A player's KYC status changed. userId = subject player; actorId = the admin who
  // acted, or null for system-driven changes (vendor decision, webhook, threshold
  // re-KYC). before/after status records the transition for the audit log.
  'compliance.kyc.updated': KycStatusUpdatedSchema,

  // A player submitted KYC documents; a verification record was created and sent to
  // the provider. userId = the submitting player; referenceId = the provider reference.
  'compliance.kyc.submitted': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    referenceId: z.string(),
    provider: z.string(),
    // Forward-compatible (ADR-0016): see KycStatusUpdatedSchema's tier field comment.
    tier: KycTierSchema.default('basic'),
  }),

  // A threshold-triggered re-KYC flipped a verified player to resubmission_requested.
  // System-driven (no admin actor); reason records the metric that crossed.
  'compliance.kyc.reverify_required': z.object({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    reason: z.string(),
    // Forward-compatible (ADR-0016): see KycStatusUpdatedSchema's tier field comment.
    tier: KycTierSchema.default('basic'),
  }),

  'compliance.kyc.high_risk_signal_detected': z.object({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    referenceId: z.string(),
    vpnOrTorDetected: z.boolean(),
    dataCenterIpDetected: z.boolean(),
    duplicateDeviceDetected: z.boolean(),
    highRiskCountryDetected: z.boolean(),
    // Forward-compatible (ADR-0016): see KycStatusUpdatedSchema's tier field comment.
    tier: KycTierSchema.default('basic'),
  }),

  'notifications.created': z.object({ notificationId: UuidSchema, userId: UuidSchema }),

  'cms.page.published': authContextBase.extend({ pageId: UuidSchema, slug: z.string() }),
  'cms.page.created': cmsPageEventBase,
  'cms.page.updated': cmsPageEventBase,
  'cms.page.deleted': cmsPageEventBase,
  'cms.banner.configuration.created': cmsBannerConfigurationEventBase,
  'cms.banner.configuration.deleted': cmsBannerConfigurationEventBase,
  'cms.banner.configuration.set_default': cmsBannerConfigurationEventBase,
  'cms.banner.configuration.unset_default': z
    .object({
      placement: z.string(),
      previousBannerConfigurationId: UuidSchema.nullable(),
      actorId: UuidSchema,
    })
    .extend(authContextBase.shape),
  'cms.banner.image.set': cmsBannerImageEventBase,
  'cms.banner.image.deleted': cmsBannerImageEventBase,
  'cms.banner.schedule.created': cmsBannerScheduleEventBase,
  'cms.banner.schedule.updated': cmsBannerScheduleUpdatedEvent,

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

  // Emitted after an admin creates or deletes a tag catalog definition (the tag
  // itself, not a player assignment - see tag.player.assigned/removed for that).
  'tag.created': z.object({ key: TagKeySchema, isSticky: z.boolean(), actorId: UuidSchema }),
  'tag.deleted': z.object({ key: TagKeySchema, actorId: UuidSchema }),
  // Emitted after any tag is assigned to or removed from a player (both automated and manual).
  // actorId is the user performing the action (SYSTEM_ACTOR_ID for automated ops).
  'tag.player.assigned': tagPlayerEventBase,
  'tag.player.removed': tagPlayerEventBase,
  // Emitted after an admin creates or updates a tag rule configuration.
  'tag.rule.upserted': authContextBase.extend({
    tagKey: TagKeySchema,
    actorId: UuidSchema,
    after: z.record(z.string(), z.unknown()),
  }),

  'chat.user.mentioned': z.object({
    mentionedUserId: UuidSchema,
    byUserId: UuidSchema,
    roomId: UuidSchema.nullable(),
    messageId: z.string(),
  }),
  'player.level.changed': z.object({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    previousLevel: z.number().int(),
    newLevel: z.number().int(),
    actorId: UuidSchema,
  }),
  'player.login_blocked': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    status: PlayerStatusSchema,
  }),
  'player.account.closed': authContextBase.extend({
    playerId: UuidSchema,
    userId: UuidSchema,
    actorId: UuidSchema,
  }),
  'player.account.reopened': authContextBase.extend({
    playerId: UuidSchema,
    userId: UuidSchema,
    actorId: UuidSchema,
  }),

  'social.friend_request.sent': authContextBase.extend({
    friendshipId: UuidSchema,
    requesterId: UuidSchema,
    addresseeId: UuidSchema,
    requesterUsername: z.string(),
  }),
  'social.friend_request.accepted': authContextBase.extend({
    friendshipId: UuidSchema,
    requesterId: UuidSchema,
    addresseeId: UuidSchema,
    accepterId: UuidSchema,
    accepterUsername: z.string(),
  }),
  'social.friendship.removed': authContextBase.extend({
    friendshipId: UuidSchema,
    actorId: UuidSchema,
    actorPlayerId: UuidSchema.nullable(),
    otherUserId: UuidSchema,
    reason: z.enum(['removed_by_player', 'blocked']),
  }),
  'social.friend_request.declined': authContextBase.extend({
    friendshipId: UuidSchema,
    requesterId: UuidSchema,
    addresseeId: UuidSchema,
  }),
  'social.friend_request.cancelled': authContextBase.extend({
    friendshipId: UuidSchema,
    requesterId: UuidSchema,
    addresseeId: UuidSchema,
  }),
} as const;

export type DomainEventName = keyof typeof domainEventSchemas;
export type DomainEventPayload<K extends DomainEventName> = z.infer<(typeof domainEventSchemas)[K]>;

// Bump an entry only when its payload shape changes in a non-additive way, in the SAME commit
// that edits the schema above. Events not listed default to version 1.
export const domainEventVersions: Partial<Record<DomainEventName, number>> = {
  // v3: actorId is nullable - null marks a system-driven flip (vendor/webhook/reverify),
  // which the audit writer records as actorType 'system'.
  'compliance.kyc.updated': 5,
  'compliance.kyc.submitted': 2,
  'compliance.kyc.reverify_required': 2,
  'compliance.kyc.high_risk_signal_detected': 2,
  // v2: sessionToken (the raw bearer credential) replaced with sessionId - the token
  // must never be persisted to the audit log or handed back to any caller.
  'identity.session.revoked': 2,
  // v2: `method` records which factor was used, required by the audit trail.
  'identity.2fa.enabled': 2,
  'identity.2fa.disabled': 2,
  // v2: exact decimal-string amount (+ currency), never a JS number.
  'wallet.deposit.completed': 2,
  'wallet.withdrawal.completed': 2,
  'wallet.withdrawal.requested': 2,
  'wallet.withdrawal.approved': 2,
  'wallet.withdrawal.rejected': 2,
  'wallet.withdrawal.failed': 2,
  'wallet.manual_adjustment.created': 2,
  // v2: amount/previousAmount (decimal string) + minutes/previousMinutes polymorphic
  // pair (money limit vs session-time limit), never a JS number.
  'rg.limit.set': 4,
  'rg.cooling_off.activated': 2,
  // v2: permanent renamed to isPermanent (non-predicate boolean naming rule).
  // v3: durationMonths added - the chosen term, explicit for the regulatory export.
  'rg.self_exclusion.activated': 4,
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

import {
  EVENT_BUS,
  DRIZZLE,
  AUDIT_DRIZZLE,
  AUDIT_SHIPPER_DRIZZLE,
  ADMIN_GUARD,
  DrizzleService,
  createLogger,
  type Container,
  type CoreTokenCatalog,
  type DrizzleDb,
  type DrizzleTx,
  type Plugin,
} from '@openora/core/server';
import {
  AUDIT_READER,
  AUDIT_WRITER,
  DEFAULT_LOBBY_LAYOUT_KEY,
  IDENTITY_READER,
  type EventEnvelope,
} from '@openora/core/contracts';
import { AuditReaderService } from './service/audit-reader.service.js';
import {
  AuditService,
  enqueueAuditInTransaction,
  enqueueEventAuditInTransaction,
  type RecordInput,
} from './service/audit.service.js';
import { AuditShipper } from './service/audit-shipper.service.js';
import { createAuditRouter } from './router/index.js';
import { AUDIT_COVERAGE_GAPS } from './contract/coverage.js';
import { SUBSCRIBED_TOPICS } from './contract/subscribed-topics.js';

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function identitySubject(
  p: Record<string, unknown>,
): Pick<RecordInput, 'resourceType' | 'resourceId'> {
  return typeof p['playerId'] === 'string'
    ? { resourceType: 'player', resourceId: p['playerId'] }
    : { resourceType: 'user', resourceId: str(p['userId']) };
}

function withdrawalSubject(
  p: Record<string, unknown>,
): Pick<RecordInput, 'resourceType' | 'resourceId'> {
  return typeof p['playerId'] === 'string'
    ? { resourceType: 'player', resourceId: p['playerId'] }
    : { resourceType: 'withdrawal', resourceId: str(p['transactionId']) };
}

export async function mapEventToRecord(
  topic: string,
  p: Record<string, unknown>,
): Promise<RecordInput> {
  const result = /\.(failed|rejected|declined)$/.test(topic) ? 'failure' : 'success';

  const base: RecordInput = {
    actorType: 'system',
    action: topic,
    resourceType: topic.split('.')[0] ?? topic,
    resourceId: null,
    after: p,
    result,
    ip: typeof p['ip'] === 'string' ? p['ip'] : null,
    userAgent: typeof p['userAgent'] === 'string' ? p['userAgent'] : null,
  };

  if (topic === 'compliance.kyc.updated') {
    return {
      ...base,
      actorType: p['actorId'] ? 'admin' : 'system',
      actorId: str(p['actorId']),
      resourceType: 'player',
      resourceId: str(p['playerId']),
      before: { kycStatus: p['previousStatus'] ?? null, tier: p['tier'] ?? null },
      after: {
        kycStatus: p['status'] ?? null,
        tier: p['tier'] ?? null,
        reason: p['reason'] ?? null,
        source: p['source'] ?? null,
      },
    };
  }

  if (topic === 'compliance.kyc.submitted') {
    return {
      ...base,
      actorType: 'player',
      actorId: str(p['playerId']),
      resourceType: 'player',
      resourceId: str(p['playerId']),
      after: {
        referenceId: p['referenceId'] ?? null,
        provider: p['provider'] ?? null,
        tier: p['tier'] ?? null,
      },
    };
  }

  if (topic === 'compliance.kyc.reverify_required') {
    return {
      ...base,
      actorType: 'system',
      resourceType: 'player',
      resourceId: str(p['playerId']),
      after: { reason: p['reason'] ?? null, tier: p['tier'] ?? null },
    };
  }

  if (topic === 'compliance.kyc.high_risk_signal_detected') {
    return {
      ...base,
      actorType: 'system',
      resourceType: 'player',
      resourceId: str(p['playerId']),
      after: {
        referenceId: p['referenceId'] ?? null,
        tier: p['tier'] ?? null,
        vpnOrTorDetected: p['vpnOrTorDetected'] ?? null,
        dataCenterIpDetected: p['dataCenterIpDetected'] ?? null,
        duplicateDeviceDetected: p['duplicateDeviceDetected'] ?? null,
        highRiskCountryDetected: p['highRiskCountryDetected'] ?? null,
      },
    };
  }

  if (
    topic === 'compliance.kyc.underage_detected' ||
    topic === 'compliance.kyc.dob_mismatch_detected'
  ) {
    return {
      ...base,
      actorType: 'system',
      resourceType: 'player',
      resourceId: str(p['playerId']),
      after: { referenceId: p['referenceId'] ?? null, tier: p['tier'] ?? null },
    };
  }

  if (topic === 'compliance.geo.access_blocked') {
    return {
      ...base,
      actorType: 'system',
      resourceType: 'geo-access',
      resourceId: str(p['countryCode']),
      result: 'failure',
      after: { countryCode: p['countryCode'] ?? null, reason: p['reason'] ?? null },
    };
  }

  if (topic === 'compliance.geo.access_redirected') {
    return {
      ...base,
      actorType: 'system',
      resourceType: 'geo-access',
      resourceId: str(p['countryCode']),
      after: { countryCode: p['countryCode'] ?? null, redirectUrl: p['redirectUrl'] ?? null },
    };
  }

  if (topic === 'compliance.geo-rule.added') {
    return {
      ...base,
      actorType: typeof p['actorId'] === 'string' ? 'admin' : 'system',
      actorId: str(p['actorId']),
      resourceType: 'geo-rule',
      resourceId: str(p['countryCode']),
      after: { action: p['action'] ?? null },
    };
  }

  if (
    topic === 'compliance.game-geo-rule.upserted' ||
    topic === 'compliance.game-geo-rule.deleted'
  ) {
    return {
      ...base,
      actorType: typeof p['actorId'] === 'string' ? 'admin' : 'system',
      actorId: str(p['actorId']),
      resourceType: 'game-geo-rule',
      resourceId: str(p['ruleId']),
      before: isRecord(p['before']) ? p['before'] : null,
      after: {
        state: isRecord(p['after']) ? p['after'] : null,
        reason: p['reason'] ?? null,
        gameId: p['gameId'] ?? null,
        countryCode: p['countryCode'] ?? null,
      },
    };
  }

  if (
    topic === 'compliance.provider-geo-rule.upserted' ||
    topic === 'compliance.provider-geo-rule.deleted'
  ) {
    return {
      ...base,
      actorType: 'admin',
      actorId: str(p['actorId']),
      resourceType: 'provider-geo-rule',
      resourceId: str(p['ruleId']),
      before: isRecord(p['before']) ? p['before'] : null,
      after: {
        state: isRecord(p['after']) ? p['after'] : null,
        reason: p['reason'] ?? null,
        providerId: p['providerId'] ?? null,
        countryCode: p['countryCode'] ?? null,
      },
    };
  }

  if (topic === 'wallet.withdrawal.requested') {
    return {
      ...base,
      actorType: 'player',
      actorId: str(p['playerId']),
      resourceType: 'withdrawal',
      resourceId: str(p['transactionId']),
      after: { amount: p['amount'], currency: p['currency'] },
    };
  }

  if (
    topic === 'wallet.withdrawal.approved' ||
    topic === 'wallet.withdrawal.rejected' ||
    topic === 'wallet.withdrawal.failed' ||
    topic === 'wallet.withdrawal.completed'
  ) {
    return {
      ...base,
      actorType: p['adminId'] ? 'admin' : 'system',
      actorId: str(p['adminId']),
      ...withdrawalSubject(p),
      result: topic === 'wallet.withdrawal.failed' ? 'failure' : 'success',
      after: {
        userId: str(p['userId']),
        transactionId: str(p['transactionId']),
        amount: p['amount'],
        currency: p['currency'],
        reason: p['reason'] ?? null,
      },
    };
  }

  if (topic.startsWith('iam.invitation.')) {
    const isAccepted = topic === 'iam.invitation.accepted';
    return {
      ...base,
      actorType: 'admin',
      actorId: str(isAccepted ? p['userId'] : p['actorId']),
      resourceType: 'invitation',
      resourceId: str(p['invitationId']),
      after: {
        email: p['email'] ?? null,
        roleId: p['roleId'] ?? null,
        ...(isAccepted ? { userId: p['userId'] ?? null } : {}),
      },
    };
  }

  if (topic.startsWith('iam.role.')) {
    const carriesMatrix = topic === 'iam.role.permissions.changed' || topic === 'iam.role.updated';
    const carriesTarget = topic === 'iam.role.assigned' || topic === 'iam.role.revoked';
    return {
      ...base,
      actorType: 'admin',
      actorId: str(p['actorId']),
      resourceType: 'role',
      resourceId: str(p['roleId']),
      before: carriesMatrix && isRecord(p['before']) ? p['before'] : null,
      after: carriesMatrix
        ? isRecord(p['after'])
          ? p['after']
          : null
        : carriesTarget
          ? { userId: str(p['userId']) }
          : null,
    };
  }

  if (topic === 'identity.user.unlocked') {
    return {
      ...base,
      actorType: 'admin',
      actorId: str(p['actorId']),
      resourceType: 'user',
      resourceId: str(p['userId']),
      before: {
        failedLoginAttempts: p['previousFailedAttempts'] ?? null,
        lockoutUntil: p['previousLockoutUntil'] ?? null,
      },
      after: { failedLoginAttempts: 0, lockoutUntil: null },
    };
  }

  if (topic === 'identity.password.admin_reset_requested') {
    return {
      ...base,
      actorType: 'admin',
      actorId: str(p['actorId']),
      resourceType: 'user',
      resourceId: str(p['userId']),
      after: { email: p['email'] ?? null },
    };
  }

  if (topic === 'identity.user.unauthorized_access') {
    const resource = str(p['resource']) ?? 'admin';
    const action = str(p['action']);
    const role = p['role'] ? str(p['role']) : undefined;
    const isPlayer = role === 'player';
    return {
      ...base,
      actorType: isPlayer ? 'player' : 'admin',
      actorId: isPlayer ? str(p['playerId']) : str(p['userId']),
      resourceType: resource,
      resourceId: action ? `${resource}:${action}` : null,
      result: 'failure',
    };
  }

  if (topic === 'identity.user.login_blocked') {
    return {
      ...base,
      actorType: 'system',
      ...identitySubject(p),
      result: 'failure',
    };
  }

  if (topic === 'identity.user.phone_login') {
    return {
      ...base,
      actorType: 'player',
      actorId: str(p['playerId']),
      ...identitySubject(p),
      result: 'success',
    };
  }

  if (topic === 'identity.phone_otp.requested') {
    return {
      ...base,
      actorType: 'system',
      resourceType: 'user',
      resourceId: str(p['userId']),
      result: 'success',
    };
  }

  if (topic === 'identity.phone_otp.cancelled') {
    return {
      ...base,
      actorType: 'system',
      resourceType: 'user',
      resourceId: str(p['userId']),
      result: 'failure',
      after: { reason: p['reason'] ?? null },
    };
  }

  if (topic === 'identity.user.lockout.triggered') {
    return {
      ...base,
      actorType: 'system',
      resourceType: 'user',
      resourceId: str(p['userId']),
      result: 'failure',
      after: {
        tier: p['tier'] ?? null,
        lockoutUntil: p['lockoutUntil'] ?? null,
      },
    };
  }

  if (topic === 'identity.session.revoked' || topic === 'identity.sessions.revoked_all') {
    const isSingle = topic === 'identity.session.revoked';
    const rawActorId = p['actorId'];
    const isSystem = rawActorId === undefined || rawActorId === null;
    const isForced = !isSystem && rawActorId !== p['userId'];
    const ownPlayerId = typeof p['playerId'] === 'string' ? p['playerId'] : null;
    const actorType = isSystem ? 'system' : isForced || !ownPlayerId ? 'admin' : 'player';
    const actorId = isSystem
      ? null
      : isForced
        ? str(rawActorId)
        : (ownPlayerId ?? str(p['userId']));
    return {
      ...base,
      actorType,
      actorId,
      ...(isSingle
        ? { resourceType: 'session', resourceId: str(p['sessionId']) }
        : identitySubject(p)),
    };
  }

  if (topic === 'chat.user.blocked' || topic === 'chat.user.unblocked') {
    return {
      ...base,
      actorType: 'player',
      actorId: str(p['actorPlayerId']),
      resourceType: 'player',
      resourceId: str(p['playerId']),
    };
  }

  if (topic === 'chat.user.ignored' || topic === 'chat.user.unignored') {
    return {
      ...base,
      actorType: 'player',
      actorId: str(p['actorPlayerId']),
      resourceType: 'player',
      resourceId: str(p['playerId']),
    };
  }

  if (topic === 'chat.room.member.kicked') {
    return {
      ...base,
      actorType: 'player',
      actorId: str(p['playerId']),
      resourceType: 'chat_room_member',
      resourceId: str(p['userId']),
      after: { roomId: str(p['roomId']) },
    };
  }

  if (topic === 'chat.room.member.banned') {
    return {
      ...base,
      actorType: 'player',
      actorId: str(p['playerId']) ?? str(p['bannedBy']),
      resourceType: 'chat_room_member',
      resourceId: str(p['userId']),
      before: isRecord(p['replaced']) ? p['replaced'] : null,
      after: {
        roomId: str(p['roomId']),
        reason: str(p['reason']),
        expiresAt: str(p['expiresAt']),
      },
    };
  }

  if (topic === 'chat.private_room.created' || topic === 'chat.private_room.deleted') {
    return {
      ...base,
      actorType: 'player',
      actorId: str(p['playerId']),
      resourceType: 'chat_room',
      resourceId: str(p['roomId']),
      ...(topic === 'chat.private_room.deleted'
        ? {
            before: isRecord(p['before']) ? p['before'] : null,
            after: isRecord(p['after']) ? p['after'] : null,
          }
        : {}),
    };
  }

  if (
    topic === 'chat.room.created' ||
    topic === 'chat.room.updated' ||
    topic === 'chat.room.deleted'
  ) {
    return {
      ...base,
      actorType: 'admin',
      actorId: str(p['actorId']),
      resourceType: 'chat_room',
      resourceId: str(p['roomId']),
      ...(topic === 'chat.room.created'
        ? { after: { name: str(p['name']), slug: str(p['slug']), category: str(p['category']) } }
        : {}),
      ...(topic === 'chat.room.updated' || topic === 'chat.room.deleted'
        ? { before: isRecord(p['before']) ? p['before'] : null }
        : {}),
      ...(topic === 'chat.room.updated' ? { after: isRecord(p['after']) ? p['after'] : null } : {}),
    };
  }

  if (topic === 'chat.room.member.joined' || topic === 'chat.room.member.left') {
    const adminId = str(p['adminId']);
    return {
      ...base,
      actorType: adminId ? 'admin' : 'player',
      actorId: adminId ?? str(p['playerId']),
      resourceType: 'chat_room_member',
      resourceId: str(p['userId']),
      after: { roomId: str(p['roomId']) },
    };
  }

  if (topic === 'chat.room.invite.sent' || topic === 'chat.room.invite.withheld') {
    return {
      ...base,
      actorType: 'player',
      actorId: str(p['playerId']) ?? str(p['inviterId']),
      resourceType: 'chat_room_invite',
      resourceId: str(p['inviteId']),
      after: {
        roomId: str(p['roomId']),
        inviteeId: str(p['inviteeId']),
        status: 'pending',
        ...(topic === 'chat.room.invite.withheld' ? { withheld: true } : {}),
      },
    };
  }

  if (topic === 'chat.room.invite.accepted' || topic === 'chat.room.invite.declined') {
    return {
      ...base,
      actorType: 'player',
      actorId: str(p['playerId']) ?? str(p['inviteeId']),
      resourceType: 'chat_room_invite',
      resourceId: str(p['inviteId']),
      result: 'success',
      after: {
        roomId: str(p['roomId']),
        inviterId: str(p['inviterId']),
        status: topic === 'chat.room.invite.accepted' ? 'accepted' : 'declined',
      },
    };
  }

  if (topic === 'chat.room.invite.expired') {
    const actorId = str(p['actorId']);
    const actorPlayerId = str(p['actorPlayerId']);
    return {
      ...base,
      actorType: actorId ? (actorPlayerId ? 'player' : 'admin') : 'system',
      actorId: actorId ? (actorPlayerId ?? actorId) : null,
      resourceType: 'chat_room_invite',
      resourceId: str(p['inviteId']),
      after: {
        roomId: str(p['roomId']),
        inviterId: str(p['inviterId']),
        inviteeId: str(p['inviteeId']),
        status: 'expired',
      },
    };
  }

  if (topic === 'chat.room.member.role-changed') {
    const actorPlayerId = str(p['playerId']);
    return {
      ...base,
      actorType: actorPlayerId ? 'player' : 'admin',
      actorId: actorPlayerId ?? str(p['changedBy']),
      resourceType: 'chat_room_member',
      resourceId: str(p['userId']),
      before: { roomId: str(p['roomId']), role: str(p['previousRole']) },
      after: { roomId: str(p['roomId']), role: str(p['role']) },
    };
  }

  if (topic === 'chat.room.deletion.cancelled') {
    return {
      ...base,
      actorType: 'system',
      resourceType: 'chat_room',
      resourceId: str(p['roomId']),
      after: {
        ownerId: str(p['ownerId']),
        scheduledDeletionAt: null,
        memberCount: Array.isArray(p['memberIds']) ? p['memberIds'].length : null,
      },
    };
  }

  if (topic === 'chat.room.ownership.transferred' || topic === 'chat.room.scheduled_for_deletion') {
    return {
      ...base,
      actorType: 'system',
      resourceType: 'chat_room',
      resourceId: str(p['roomId']),
      after:
        topic === 'chat.room.ownership.transferred'
          ? {
              previousOwnerId: str(p['previousOwnerId']),
              newOwnerId: str(p['newOwnerId']),
              reason: p['reason'] ?? null,
            }
          : {
              previousOwnerId: str(p['previousOwnerId']),
              scheduledDeletionAt: p['scheduledDeletionAt'] ?? null,
              memberCount: Array.isArray(p['memberIds']) ? p['memberIds'].length : null,
            },
    };
  }

  if (topic === 'player.account.closed' || topic === 'player.account.reopened') {
    return {
      ...base,
      actorType: 'admin',
      actorId: str(p['actorId']),
      resourceType: 'player',
      resourceId: str(p['playerId']),
      after: { closed: topic === 'player.account.closed' },
    };
  }

  if (topic === 'player.status.changed') {
    return {
      ...base,
      actorType: p['actorId'] ? 'admin' : 'system',
      actorId: str(p['actorId']),
      resourceType: 'player',
      resourceId: str(p['playerId']),
      before: { status: p['previousStatus'] ?? null },
      after: { status: p['newStatus'] ?? null },
    };
  }

  if (topic === 'identity.user.deactivated' || topic === 'identity.user.reactivated') {
    const isActive = topic === 'identity.user.reactivated';
    return {
      ...base,
      actorType: 'admin',
      actorId: str(p['actorId']),
      resourceType: 'user',
      resourceId: str(p['userId']),
      before: { isActive: !isActive },
      after: { isActive },
    };
  }

  if (topic === 'player.level.changed') {
    return {
      ...base,
      actorType: 'admin',
      actorId: str(p['actorId']),
      resourceType: 'player',
      resourceId: str(p['playerId']),
      before: { level: p['previousLevel'] ?? null },
      after: { level: p['newLevel'] ?? null },
    };
  }

  if (topic === 'tag.player.assigned' || topic === 'tag.player.removed') {
    const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000000';
    const actorId = str(p['actorId']);
    return {
      ...base,
      actorType: actorId === SYSTEM_ACTOR ? 'system' : 'admin',
      actorId,
      resourceType: 'player',
      resourceId: str(p['playerId']),
      after: { tagKey: p['tagKey'], reason: p['reason'] },
    };
  }

  if (topic === 'social.friend_request.sent') {
    return {
      ...base,
      actorType: 'player',
      actorId: str(p['requesterId']),
      resourceType: 'friendship',
      resourceId: str(p['friendshipId']),
      after: { addresseeId: str(p['addresseeId']), status: 'pending' },
    };
  }

  if (topic === 'social.friend_request.accepted') {
    return {
      ...base,
      actorType: 'player',
      actorId: str(p['accepterId']),
      resourceType: 'friendship',
      resourceId: str(p['friendshipId']),
      after: { status: 'accepted' },
    };
  }

  if (topic === 'social.friendship.removed') {
    const actorPlayerId = p['actorPlayerId'];
    return {
      ...base,
      actorType: actorPlayerId ? 'player' : 'admin',
      actorId: actorPlayerId ? str(actorPlayerId) : str(p['actorId']),
      resourceType: 'friendship',
      resourceId: str(p['friendshipId']),
      after: { status: 'removed', reason: p['reason'] },
    };
  }

  if (topic === 'social.friend_request.declined') {
    return {
      ...base,
      actorType: 'player',
      actorId: str(p['addresseeId']),
      resourceType: 'friendship',
      resourceId: str(p['friendshipId']),
      after: { status: 'declined' },
    };
  }

  if (topic === 'social.friend_request.cancelled') {
    return {
      ...base,
      actorType: 'player',
      actorId: str(p['requesterId']),
      resourceType: 'friendship',
      resourceId: str(p['friendshipId']),
      after: { status: 'cancelled' },
    };
  }

  if (topic === 'cms.banner.schedule.created' || topic === 'cms.banner.schedule.updated') {
    return {
      ...base,
      actorType: 'admin',
      actorId: str(p['actorId']),
      resourceType: 'banner_schedule',
      resourceId: str(p['bannerScheduleId']),
      ...(topic === 'cms.banner.schedule.updated' && isRecord(p['before'])
        ? { before: p['before'] }
        : {}),
      after: {
        bannerConfigurationId: str(p['bannerConfigurationId']),
        placement: str(p['placement']),
        startsAt: str(p['startsAt']),
        endsAt: str(p['endsAt']),
      },
    };
  }

  if (
    topic === 'cms.page.created' ||
    topic === 'cms.page.updated' ||
    topic === 'cms.page.deleted' ||
    topic === 'cms.banner.configuration.created' ||
    topic === 'cms.banner.configuration.deleted' ||
    topic === 'cms.banner.configuration.set_default' ||
    topic === 'cms.banner.configuration.unset_default' ||
    topic === 'cms.banner.image.set' ||
    topic === 'cms.banner.image.deleted'
  ) {
    const isBanner = topic.startsWith('cms.banner.');
    const bannerResourceId =
      topic === 'cms.banner.configuration.unset_default'
        ? (str(p['previousBannerConfigurationId']) ?? str(p['placement']))
        : (str(p['bannerImageId']) ?? str(p['bannerConfigurationId']));
    return {
      ...base,
      actorType: 'admin',
      actorId: str(p['actorId']),
      resourceType: isBanner ? 'banner' : 'page',
      resourceId: isBanner ? bannerResourceId : str(p['pageId']),
    };
  }

  if (topic === 'lobby.layout.updated') {
    return {
      ...base,
      actorType: typeof p['actorId'] === 'string' ? 'admin' : 'system',
      actorId: str(p['actorId']),
      resourceType: 'lobby-layout',
      resourceId: str(p['layoutKey']) ?? DEFAULT_LOBBY_LAYOUT_KEY,
      before: isRecord(p['before']) ? p['before'] : null,
      after: isRecord(p['after']) ? p['after'] : null,
    };
  }

  if (topic === 'notifications.created') {
    return {
      ...base,
      actorType: 'system',
      resourceType: 'notification',
      resourceId: str(p['notificationId']),
      after: { userId: str(p['userId']) },
    };
  }

  if (topic === 'tag.rule.upserted') {
    return {
      ...base,
      actorType: 'admin',
      actorId: str(p['actorId']),
      resourceType: 'tag-rule',
      resourceId: str(p['tagKey']),
      after: isRecord(p['after']) ? p['after'] : null,
    };
  }
  if (topic === 'tag.created' || topic === 'tag.deleted') {
    return {
      ...base,
      actorType: 'admin',
      actorId: str(p['actorId']),
      resourceType: 'tag',
      resourceId: str(p['key']),
    };
  }
  if (
    topic === 'rg.limit.set' ||
    topic === 'rg.limit.change_requested' ||
    topic === 'rg.limit.change_confirmed' ||
    topic === 'rg.limit.change_cancelled' ||
    topic === 'rg.cooling_off.activated' ||
    topic === 'rg.self_exclusion.activated' ||
    topic === 'rg.self_exclusion.lifted' ||
    topic === 'rg.cooling_off.lifted'
  ) {
    const before =
      topic === 'rg.limit.set' || topic === 'rg.limit.change_confirmed'
        ? {
            amount: p['previousAmount'] ?? null,
            minutes: p['previousMinutes'] ?? null,
            ...(topic === 'rg.limit.set' ? { currency: p['previousCurrency'] ?? null } : {}),
          }
        : topic === 'rg.self_exclusion.lifted' || topic === 'rg.cooling_off.lifted'
          ? { status: 'active' }
          : null;
    const initiatedBy = p['initiatedBy'];
    return {
      ...base,
      actorType:
        initiatedBy === 'player' || initiatedBy === 'system' || initiatedBy === 'admin'
          ? initiatedBy
          : 'admin',
      actorId: str(p['actorId']),
      resourceType: 'player',
      resourceId: str(p['playerId']),
      before,
      after: p,
    };
  }

  if (topic === 'rg.limit.change_expired') {
    return {
      ...base,
      actorType: 'system',
      resourceType: 'player',
      resourceId: str(p['playerId']),
      before: { pendingAmount: p['requestedAmount'] ?? null },
      after: p,
    };
  }

  if (topic === 'rg.cooling_off.expired') {
    return {
      ...base,
      actorType: 'system',
      resourceType: 'player',
      resourceId: str(p['playerId']),
      before: { status: 'active' },
      after: p,
    };
  }

  if (topic === 'rg.exclusion.login_blocked') {
    return {
      ...base,
      actorType: 'system',
      resourceType: 'player',
      resourceId: str(p['playerId']),
      result: 'failure',
    };
  }

  if (topic === 'player.login_blocked') {
    return {
      ...base,
      actorType: 'system',
      resourceType: 'player',
      resourceId: str(p['playerId']),
      result: 'failure',
    };
  }

  if (topic === 'wallet.reconciliation.alert') {
    return {
      ...base,
      actorType: 'system',
      resourceType: 'wallet_job_run',
      resourceId: str(p['runId']),
      after: {
        openFindings: p['openFindings'] ?? null,
        threshold: p['threshold'] ?? null,
        failedChecks: p['failedChecks'] ?? null,
        projectionRepairsDeferred: p['projectionRepairsDeferred'] ?? null,
      },
    };
  }

  if (topic === 'gaming.provider.created') {
    return {
      ...base,
      actorType: 'admin',
      actorId: str(p['actorId']),
      resourceType: 'game_provider',
      resourceId: str(p['providerId']),
      after: {
        slug: p['slug'] ?? null,
        name: p['name'] ?? null,
        aggregatorMappings: p['aggregatorMappings'] ?? [],
        logoUrl: p['logoUrl'] ?? null,
        customLogoUrl: p['customLogoUrl'] ?? null,
        metadata: p['metadata'] ?? null,
        isActive: p['isActive'] ?? null,
        autoApproveNewGames: p['autoApproveNewGames'] ?? false,
      },
    };
  }

  if (topic === 'gaming.provider.updated') {
    return {
      ...base,
      actorType: 'admin',
      actorId: str(p['actorId']),
      resourceType: 'game_provider',
      resourceId: str(p['providerId']),
      before: isRecord(p['before']) ? p['before'] : null,
      after: isRecord(p['after']) ? p['after'] : null,
      correlationId: str(p['bulkOperationId']),
    };
  }

  if (topic === 'gaming.category.created') {
    return {
      ...base,
      actorType: 'admin',
      actorId: str(p['actorId']),
      resourceType: 'game_category',
      resourceId: str(p['categoryId']),
      after: {
        slug: p['slug'] ?? null,
        name: p['name'] ?? null,
        translations: p['translations'] ?? {},
        icon: p['icon'] ?? null,
        sortOrder: p['sortOrder'] ?? null,
        isActive: p['isActive'] ?? null,
        sortKey: p['sortKey'] ?? null,
        sortDirection: p['sortDirection'] ?? null,
        sortParams: p['sortParams'] ?? {},
        rankedAt: p['rankedAt'] ?? null,
        membershipMode: p['membershipMode'] ?? null,
        membershipRule: p['membershipRule'] ?? null,
      },
    };
  }

  if (topic === 'gaming.category.updated') {
    return {
      ...base,
      actorType: 'admin',
      actorId: str(p['actorId']),
      resourceType: 'game_category',
      resourceId: str(p['categoryId']),
      before: isRecord(p['before']) ? p['before'] : null,
      after: isRecord(p['after']) ? p['after'] : null,
    };
  }

  if (topic === 'gaming.category.games_reordered') {
    return {
      ...base,
      actorType: 'admin',
      actorId: str(p['actorId']),
      resourceType: 'game_category',
      resourceId: str(p['categoryId']),
      before: {
        gameIds: Array.isArray(p['before']) ? p['before'] : [],
        sortKey: p['sortKeyBefore'] ?? null,
        sortDirection: p['sortDirectionBefore'] ?? null,
        sortParams: p['sortParamsBefore'] ?? {},
      },
      after: {
        gameIds: Array.isArray(p['after']) ? p['after'] : [],
        sortKey: p['sortKeyAfter'] ?? null,
        sortDirection: p['sortDirectionAfter'] ?? null,
        sortParams: p['sortParamsAfter'] ?? {},
      },
    };
  }

  if (topic === 'gaming.category.pins_updated') {
    return {
      ...base,
      actorType: 'admin',
      actorId: str(p['actorId']),
      resourceType: 'game_category',
      resourceId: str(p['categoryId']),
      before: { pins: Array.isArray(p['before']) ? p['before'] : [] },
      after: { pins: Array.isArray(p['after']) ? p['after'] : [] },
    };
  }

  if (topic === 'gaming.category.membership_evaluated') {
    const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000000';
    const actorId = str(p['actorId']);
    return {
      ...base,
      actorType: actorId === SYSTEM_ACTOR ? 'system' : 'admin',
      actorId,
      resourceType: 'game_category',
      resourceId: str(p['categoryId']),
      before: { removedGameIds: Array.isArray(p['removedGameIds']) ? p['removedGameIds'] : [] },
      after: {
        trigger: p['trigger'] ?? null,
        matchedCount: p['matchedCount'] ?? null,
        relabeledCount: p['relabeledCount'] ?? 0,
        addedGameIds: Array.isArray(p['addedGameIds']) ? p['addedGameIds'] : [],
      },
    };
  }

  if (topic === 'gaming.category.membership_evaluation.failed') {
    return {
      ...base,
      actorType: 'admin',
      actorId: str(p['actorId']),
      resourceType: 'game_category',
      resourceId: str(p['categoryId']),
      after: { reason: p['reason'] ?? null },
    };
  }

  if (topic === 'gaming.tag.created') {
    return {
      ...base,
      actorType: 'admin',
      actorId: str(p['actorId']),
      resourceType: 'game_tag',
      resourceId: str(p['tagId']),
      after: {
        name: p['name'] ?? null,
        type: p['type'] ?? null,
        visibility: p['visibility'] ?? null,
        metadata: p['metadata'] ?? null,
      },
    };
  }

  if (topic === 'gaming.tag.updated') {
    return {
      ...base,
      actorType: 'admin',
      actorId: str(p['actorId']),
      resourceType: 'game_tag',
      resourceId: str(p['tagId']),
      before: isRecord(p['before']) ? p['before'] : null,
      after: isRecord(p['after']) ? p['after'] : null,
    };
  }

  if (topic === 'gaming.tag.deleted') {
    return {
      ...base,
      actorType: 'admin',
      actorId: str(p['actorId']),
      resourceType: 'game_tag',
      resourceId: str(p['tagId']),
      before: isRecord(p['before']) ? p['before'] : null,
      after: isRecord(p['after']) ? p['after'] : null,
    };
  }

  if (topic === 'gaming.game.updated') {
    return {
      ...base,
      actorType: 'admin',
      actorId: str(p['actorId']),
      resourceType: 'game',
      resourceId: str(p['gameId']),
      before: isRecord(p['before']) ? p['before'] : null,
      after: isRecord(p['after']) ? p['after'] : null,
    };
  }

  if (topic === 'gaming.games.bulk_updated') {
    const operation = p['operation'];
    const linkIdsKey = operation === 'add_tags' ? 'tagIds' : 'categoryIds';
    const before =
      operation === 'set_active'
        ? {
            isActive: !p['isActive'],
            gameIds: Array.isArray(p['changedGameIds']) ? p['changedGameIds'] : [],
            providerIds: Array.isArray(p['changedProviderIds']) ? p['changedProviderIds'] : [],
          }
        : {
            addedLinks: (Array.isArray(p['addedLinks']) ? p['addedLinks'] : []).map(
              (link: Record<string, unknown>) => ({ gameId: link['gameId'], [linkIdsKey]: [] }),
            ),
          };
    return {
      ...base,
      actorType: 'admin',
      actorId: str(p['actorId']),
      resourceType: 'game',
      resourceId: null,
      before,
      after: p,
      correlationId: operation === 'set_active' ? str(p['bulkOperationId']) : null,
    };
  }

  if (topic === 'gaming.games.reviewed') {
    const gameIds = Array.isArray(p['gameIds']) ? p['gameIds'] : [];
    return {
      ...base,
      actorType: 'admin',
      actorId: str(p['actorId']),
      resourceType: 'game',
      resourceId: gameIds.length === 1 ? str(gameIds[0]) : null,
      before: { reviewStatus: p['previousStatus'] ?? null, gameIds },
      after: { reviewStatus: p['decision'] === 'approve' ? 'approved' : 'declined', gameIds },
      correlationId: str(p['bulkOperationId']),
    };
  }

  if (topic === 'gaming.games.auto_approved') {
    return {
      ...base,
      actorType: 'system',
      resourceType: 'game_provider',
      resourceId: str(p['providerId']),
      after: {
        reviewStatus: 'auto_approved',
        gameIds: Array.isArray(p['gameIds']) ? p['gameIds'] : [],
      },
    };
  }

  if (topic === 'gaming.games.created') {
    return { ...base, resourceType: 'game', before: null, after: { gameIds: p['gameIds'] ?? [] } };
  }

  if (topic === 'gaming.games.changed') {
    return {
      ...base,
      resourceType: 'game',
      before: { tagIds: p['tagIds'] ?? [], providerIds: p['providerIds'] ?? [] },
      after: { gameIds: p['gameIds'] ?? [] },
    };
  }

  if (topic === 'gaming.game.availability_changed') {
    return {
      ...base,
      actorType: 'system',
      resourceType: 'game',
      resourceId: str(p['gameId']),
      before: isRecord(p['before']) ? p['before'] : null,
      after: isRecord(p['after']) ? p['after'] : null,
    };
  }

  if (topic.startsWith('wallet.')) {
    return {
      ...base,
      actorType: 'player',
      actorId: str(p['playerId']),
      resourceType: 'transaction',
      resourceId: str(p['transactionId']),
      after: p,
    };
  }

  if (topic === 'identity.user.registered') {
    return { ...base, actorId: str(p['playerId']), actorType: 'player' };
  }

  if (topic === 'identity.user.registration.failed') {
    return { ...base, resourceType: 'registration' };
  }

  if (topic === 'identity.2fa.reset' || topic === 'identity.trusted_device.revoked') {
    const rawActorId = p['actorId'];
    const isSystem = rawActorId === undefined || rawActorId === null;
    const isForced = !isSystem && rawActorId !== p['userId'];
    const playerId = str(p['playerId']);
    return {
      ...base,
      actorType: isSystem ? 'system' : isForced || !playerId ? 'admin' : 'player',
      actorId: isSystem ? null : isForced ? str(rawActorId) : (playerId ?? str(p['userId'])),
      ...identitySubject(p),
    };
  }

  if (topic === 'identity.email.changed') {
    const playerId = p['playerId'];
    return {
      ...base,
      actorType: playerId ? 'player' : 'admin',
      actorId: playerId ? str(playerId) : str(p['userId']),
      ...identitySubject(p),
      before: { email: str(p['previousEmail']) },
      after: {
        email: str(p['newEmail']),
        ...(typeof p['changedAt'] === 'string' ? { changedAt: p['changedAt'] } : {}),
      },
    };
  }

  if (topic === 'identity.phone.verified') {
    const playerId = p['playerId'];
    return {
      ...base,
      actorType: playerId ? 'player' : 'admin',
      actorId: playerId ? str(playerId) : str(p['userId']),
      ...identitySubject(p),
      before: { phoneVerified: p['previousPhoneVerified'] ?? null },
      after: { phoneVerified: true },
    };
  }

  if (topic === 'identity.security.login_withdrawal_alerts.updated') {
    const playerId = p['playerId'];
    return {
      ...base,
      actorType: playerId ? 'player' : 'admin',
      actorId: playerId ? str(playerId) : str(p['userId']),
      ...identitySubject(p),
      before: { loginWithdrawalAlertsEnabled: p['previousEnabled'] ?? null },
      after: { loginWithdrawalAlertsEnabled: p['enabled'] ?? null },
    };
  }

  if (topic === 'identity.security.auto_logout.updated') {
    const playerId = p['playerId'];
    return {
      ...base,
      actorType: playerId ? 'player' : 'admin',
      actorId: playerId ? str(playerId) : str(p['userId']),
      ...identitySubject(p),
      before: { autoLogoutDuration: p['previousDuration'] ?? null },
      after: { autoLogoutDuration: p['duration'] ?? null },
    };
  }

  if (topic === 'identity.security.require_two_factor.updated') {
    const playerId = p['playerId'];
    return {
      ...base,
      actorType: playerId ? 'player' : 'admin',
      actorId: playerId ? str(playerId) : str(p['userId']),
      ...identitySubject(p),
      before: { requireTwoFactorOnLogin: p['previousEnabled'] ?? null },
      after: { requireTwoFactorOnLogin: p['enabled'] ?? null },
    };
  }

  if (topic === 'identity.security.withdrawal_pin.set') {
    const playerId = p['playerId'];
    return {
      ...base,
      actorType: playerId ? 'player' : 'admin',
      actorId: playerId ? str(playerId) : str(p['userId']),
      ...identitySubject(p),
      before: { withdrawalPinSet: p['wasAlreadySet'] ?? null },
      after: { withdrawalPinSet: true },
    };
  }

  if (topic === 'identity.security.withdrawal_pin.removed') {
    const playerId = p['playerId'];
    return {
      ...base,
      actorType: playerId ? 'player' : 'admin',
      actorId: playerId ? str(playerId) : str(p['userId']),
      ...identitySubject(p),
      before: { withdrawalPinSet: true },
      after: { withdrawalPinSet: false },
    };
  }

  if (topic === 'identity.security.withdrawal_pin.locked') {
    const playerId = p['playerId'];
    return {
      ...base,
      actorType: playerId ? 'player' : 'admin',
      actorId: playerId ? str(playerId) : str(p['userId']),
      ...identitySubject(p),
      after: { withdrawalPinLockedUntil: p['lockedUntil'] ?? null },
    };
  }

  if (topic === 'identity.security.anti_phishing_code.set') {
    const playerId = p['playerId'];
    return {
      ...base,
      actorType: playerId ? 'player' : 'admin',
      actorId: playerId ? str(playerId) : str(p['userId']),
      ...identitySubject(p),
      before: { antiPhishingCodeSet: p['wasAlreadySet'] ?? null },
      after: { antiPhishingCodeSet: true },
    };
  }

  if (
    topic === 'identity.user.login' ||
    topic === 'identity.user.logout' ||
    topic === 'identity.2fa.enabled' ||
    topic === 'identity.2fa.disabled' ||
    topic === 'identity.2fa.verified' ||
    topic === 'identity.2fa.failed' ||
    topic === 'identity.2fa.backup_codes_regenerated' ||
    topic === 'identity.2fa.lockout.triggered' ||
    topic === 'identity.2fa.enrollment_blocked' ||
    topic === 'identity.session.fingerprint_mismatch' ||
    topic === 'identity.trusted_device.added' ||
    topic === 'identity.password.reset' ||
    topic === 'identity.password.changed' ||
    topic === 'identity.email.verified' ||
    topic === 'identity.profile.updated'
  ) {
    const playerId = p['playerId'];
    return playerId
      ? { ...base, ...identitySubject(p), actorId: str(playerId), actorType: 'player' }
      : { ...base, ...identitySubject(p), actorId: str(p['userId']), actorType: 'admin' };
  }

  if (typeof p['userId'] === 'string') {
    return { ...base, actorId: str(p['playerId']), actorType: 'player' };
  }

  return base;
}

const AUDIT_CONSUMER_GROUP = 'audit';

const shippedDatabases = new WeakSet<object>();

const AUDITED_TOPICS: ReadonlySet<string> = new Set([
  ...SUBSCRIBED_TOPICS,
  ...Object.entries(AUDIT_COVERAGE_GAPS)
    .filter(([, coverage]) => coverage.kind === 'atSource')
    .map(([topic]) => topic),
]);

const SUBSCRIBED: ReadonlySet<string> = new Set(SUBSCRIBED_TOPICS);

export async function auditRecordFor(
  topic: string,
  payload: unknown,
  envelope: Pick<EventEnvelope, 'correlationId'> | undefined,
): Promise<RecordInput | null> {
  if (!SUBSCRIBED.has(topic) || !isRecord(payload) || payload['auditRecorded'] === true) {
    return null;
  }
  const record = await mapEventToRecord(topic, payload);
  return { ...record, correlationId: record.correlationId ?? envelope?.correlationId ?? null };
}

const AUDIT_POOL_SIZE_ENV = { env: 'AUDIT_DATABASE_POOL_MAX', fallback: 3 };

function splitAuditUrls(): { audit: string; shipper: string } | null {
  const audit = process.env['AUDIT_DATABASE_URL'];
  if (!audit) {
    return null;
  }
  const shipper = process.env['AUDIT_SHIPPER_DATABASE_URL'];
  if (!shipper) {
    throw new Error(
      'AUDIT_SHIPPER_DATABASE_URL is required with AUDIT_DATABASE_URL: only its role may delete shipped audit_outbox rows',
    );
  }
  return { audit, shipper };
}

export default {
  id: 'audit',
  register(ctx) {
    let dbRef: DrizzleDb | null = null;

    const split = splitAuditUrls();
    const ownPool = (c: Pick<Container<CoreTokenCatalog>, 'onDispose'>, url: string) => {
      const svc = new DrizzleService(url, { poolSize: AUDIT_POOL_SIZE_ENV });
      c.onDispose(() => svc.dispose());
      return svc;
    };
    ctx.provideSealed(AUDIT_DRIZZLE, (c) => (split ? ownPool(c, split.audit) : c.get(DRIZZLE)));
    ctx.provideSealed(AUDIT_SHIPPER_DRIZZLE, (c) =>
      split ? ownPool(c, split.shipper) : c.get(DRIZZLE),
    );
    ctx.provide(AUDIT_READER, (c) => new AuditReaderService(c.get(DRIZZLE), c.get(AUDIT_DRIZZLE)));

    ctx.provideSealed(AUDIT_WRITER, (c) => {
      const svc = new AuditService(c.get(DRIZZLE), c.get(EVENT_BUS), c.get(IDENTITY_READER));
      return {
        auditedTopics: AUDITED_TOPICS,
        record: (entry) => svc.record(entry),
        recordInTransaction: (tx, entry) => svc.recordInTransaction(tx, entry),
        recordManyInTransaction: (tx, entries) => svc.recordManyInTransaction(tx, entries),
      };
    });

    for (const topic of SUBSCRIBED_TOPICS) {
      ctx.events.on(
        topic,
        async (payload, envelope) => {
          const record = await auditRecordFor(topic, payload, envelope);
          if (!record) {
            return;
          }
          if (!dbRef) {
            throw new Error(`audit record for '${topic}' skipped - service not constructed`);
          }
          await dbRef.transaction((tx) =>
            envelope
              ? enqueueEventAuditInTransaction(tx, record, envelope)
              : enqueueAuditInTransaction(tx, record),
          );
        },
        { consumerGroup: AUDIT_CONSUMER_GROUP },
      );
    }

    ctx.routers.add('audit', (c) => {
      const drizzle = c.get(DRIZZLE);
      const events = c.get(EVENT_BUS);
      const auditDrizzle = c.get(AUDIT_DRIZZLE);
      const svc = new AuditService(drizzle, events, c.get(IDENTITY_READER), auditDrizzle);
      dbRef = drizzle.db;
      events.tapTransactional(async (tx, envelope) => {
        const record = await auditRecordFor(envelope.topic, envelope.payload, envelope);
        if (record) {
          await enqueueEventAuditInTransaction(tx as DrizzleTx, record, envelope);
        }
      });
      if (!shippedDatabases.has(drizzle.db)) {
        shippedDatabases.add(drizzle.db);
        const shipper = new AuditShipper(c.get(AUDIT_SHIPPER_DRIZZLE).db, {
          chainDb: auditDrizzle.db,
          onError: (err) => createLogger('audit-shipper').error({ err }, 'audit shipping failed'),
        });
        shipper.start();
        c.onDispose(async () => {
          await shipper.stop();
          shippedDatabases.delete(drizzle.db);
        });
      }
      return createAuditRouter(svc, c.get(ADMIN_GUARD));
    });
  },
} as const satisfies Plugin<CoreTokenCatalog>;

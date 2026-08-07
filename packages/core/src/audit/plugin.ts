import { EVENT_BUS, DRIZZLE, ADMIN_GUARD, createLogger } from '@openora/core/server';
import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { AUDIT_WRITER, type DomainEventName } from '@openora/core/contracts';
import { AuditService, type RecordInput } from './service/audit.service.js';
import { createAuditRouter } from './router/index.js';

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function mapEventToRecord(topic: string, p: Record<string, unknown>): RecordInput {
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

  // payload `userId` is the SUBJECT player here, not the actor (an admin changed it).
  if (topic === 'compliance.kyc.updated') {
    return {
      ...base,
      actorType: p['actorId'] ? 'admin' : 'system',
      actorId: str(p['actorId']),
      resourceType: 'player',
      resourceId: str(p['userId']),
      before: { kycStatus: p['previousStatus'] ?? null },
      after: {
        kycStatus: p['status'] ?? null,
        reason: p['reason'] ?? null,
        source: p['source'] ?? null,
      },
    };
  }

  // Player submitted KYC documents. actorId = the player; resourceId = the player.
  if (topic === 'compliance.kyc.submitted') {
    return {
      ...base,
      actorType: 'player',
      actorId: str(p['userId']),
      resourceType: 'player',
      resourceId: str(p['userId']),
      after: { referenceId: p['referenceId'] ?? null, provider: p['provider'] ?? null },
    };
  }

  // System-driven re-KYC trigger. No admin actor; resource = the subject player.
  if (topic === 'compliance.kyc.reverify_required') {
    return {
      ...base,
      actorType: 'system',
      resourceType: 'player',
      resourceId: str(p['userId']),
      after: { reason: p['reason'] ?? null },
    };
  }

  if (topic === 'compliance.kyc.high_risk_signal_detected') {
    return {
      ...base,
      actorType: 'system',
      resourceType: 'player',
      resourceId: str(p['userId']),
      after: {
        referenceId: p['referenceId'] ?? null,
        vpnOrTorDetected: p['vpnOrTorDetected'] ?? null,
        dataCenterIpDetected: p['dataCenterIpDetected'] ?? null,
        duplicateDeviceDetected: p['duplicateDeviceDetected'] ?? null,
        highRiskCountryDetected: p['highRiskCountryDetected'] ?? null,
      },
    };
  }

  // Admin added/changed a geo (country) rule. resourceId = the country code.
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

  // Player requested a withdrawal (funds held). actorId = the player; resourceId =
  // the withdrawal transaction.
  if (topic === 'wallet.withdrawal.requested') {
    return {
      ...base,
      actorType: 'player',
      actorId: str(p['userId']),
      resourceType: 'withdrawal',
      resourceId: str(p['transactionId']),
      after: { amount: p['amount'], currency: p['currency'] },
    };
  }

  // Admin approve/reject of a withdrawal, or a PSP-rail failure on an approved one.
  // actorId = the reviewing admin; resourceId = the withdrawal transaction; reason
  // carried on reject.
  if (
    topic === 'wallet.withdrawal.approved' ||
    topic === 'wallet.withdrawal.rejected' ||
    topic === 'wallet.withdrawal.failed'
  ) {
    return {
      ...base,
      actorType: 'admin',
      actorId: str(p['adminId']),
      resourceType: 'withdrawal',
      resourceId: str(p['transactionId']),
      after: {
        userId: str(p['userId']),
        amount: p['amount'],
        currency: p['currency'],
        reason: p['reason'] ?? null,
      },
    };
  }

  // actorId = acting admin; resourceId = subject role. permissions.changed/updated
  // carries the matrix diff; assigned/revoked carries the target user in after.userId.
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

  // Admin cleared a lockout. resource = the unlocked user; before/after carry the
  // failed-attempt + lockout state that was reset.
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

  if (topic === 'identity.user.unauthorized_access') {
    const resource = str(p['resource']) ?? 'admin';
    const action = str(p['action']);
    const role = p['role'] ? str(p['role']) : undefined;
    return {
      ...base,
      actorType: role === 'player' ? 'player' : 'admin',
      actorId: str(p['userId']),
      resourceType: resource,
      resourceId: action ? `${resource}:${action}` : null,
      result: 'failure',
    };
  }

  // Player authenticated via SMS OTP. actorId = resource = the player; success outcome.
  if (topic === 'identity.user.phone_login') {
    return {
      ...base,
      actorType: 'player',
      actorId: str(p['userId']),
      resourceType: 'user',
      resourceId: str(p['userId']),
      result: 'success',
    };
  }

  // An OTP was issued (smsOtpSession row created/upserted). System-driven credential
  // dispatch; resourceId = the user the code was sent for.
  if (topic === 'identity.phone_otp.requested') {
    return {
      ...base,
      actorType: 'system',
      resourceType: 'user',
      resourceId: str(p['userId']),
      result: 'success',
    };
  }

  // A pending OTP was cancelled. `max_attempts` is a system-driven security event
  // (guessing exhausted); recorded as a failure with the reason for the trail.
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

  // A lockout is a system-driven security control: the subject is the resource, not the
  // actor, and it is a failure outcome (the base regex would otherwise mark it success).
  if (topic === 'identity.user.lockout.triggered') {
    return {
      ...base,
      actorType: 'system',
      resourceType: 'user',
      resourceId: str(p['userId']),
      result: 'failure',
      after: { lockoutUntil: p['lockoutUntil'] ?? null },
    };
  }

  // Player/Admin revoked one or all of their own sessions, or an admin forced it.
  if (topic === 'identity.session.revoked' || topic === 'identity.sessions.revoked_all') {
    const isSingle = topic === 'identity.session.revoked';
    const actorId = p['actorId'] ? str(p['actorId']) : str(p['userId']);
    const isForced = !!p['actorId'];
    return {
      ...base,
      actorType: isForced ? 'admin' : 'player',
      actorId,
      resourceType: isSingle ? 'session' : 'user',
      resourceId: isSingle ? str(p['sessionId']) : str(p['userId']),
    };
  }

  // actorId = the player who (un)blocked; resource = the blocked player.
  if (topic === 'chat.user.blocked' || topic === 'chat.user.unblocked') {
    return {
      ...base,
      actorType: 'player',
      actorId: str(p['blockerId']),
      resourceType: 'player',
      resourceId: str(p['blockedId']),
    };
  }

  // actorId = the player who (un)ignored; resource = the ignored player.
  if (topic === 'chat.user.ignored' || topic === 'chat.user.unignored') {
    return {
      ...base,
      actorType: 'player',
      actorId: str(p['ignorerId']),
      resourceType: 'player',
      resourceId: str(p['ignoredId']),
    };
  }

  // actorId = the moderator who acted; resource = the affected player in that room.
  if (topic === 'chat.room.member.kicked' || topic === 'chat.room.member.banned') {
    const actorKey = topic === 'chat.room.member.kicked' ? 'kickedBy' : 'bannedBy';
    return {
      ...base,
      actorType: 'player',
      actorId: str(p[actorKey]),
      resourceType: 'chat_room_member',
      resourceId: str(p['userId']),
      after: { roomId: str(p['roomId']) },
    };
  }

  // actorId = the player who created/deleted the room; resource = the room.
  if (topic === 'chat.private_room.created' || topic === 'chat.private_room.deleted') {
    return {
      ...base,
      actorType: 'player',
      actorId: str(p['creatorId']),
      resourceType: 'chat_room',
      resourceId: str(p['roomId']),
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
    return {
      ...base,
      actorType: 'player',
      actorId: str(p['userId']),
      resourceType: 'chat_room_member',
      resourceId: str(p['userId']),
      after: { roomId: str(p['roomId']) },
    };
  }

  // actorType = admin (the only path flipping isActive is the back-office route);
  // resource = the subject user. after carries the new active state.
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

  // Admin changed a player's level via PlayerService.update(). resource = the
  // subject player; before/after carry the level transition.
  if (topic === 'player.level.changed') {
    return {
      ...base,
      actorType: 'admin',
      actorId: str(p['actorId']),
      resourceType: 'player',
      resourceId: str(p['userId']),
      before: { level: p['previousLevel'] ?? null },
      after: { level: p['newLevel'] ?? null },
    };
  }

  // System-automated or admin-manual tag assignment/removal.
  // actorId = SYSTEM_ACTOR_ID (zero UUID) for automated ops; admin user id for manual.
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

  // Admin CMS page/banner CRUD. actorId = acting admin; resourceId = the page/banner.
  if (
    topic === 'cms.page.created' ||
    topic === 'cms.page.updated' ||
    topic === 'cms.page.deleted' ||
    topic === 'cms.banner.created' ||
    topic === 'cms.banner.updated' ||
    topic === 'cms.banner.deleted'
  ) {
    const isBanner = topic.startsWith('cms.banner.');
    return {
      ...base,
      actorType: 'admin',
      actorId: str(p['actorId']),
      resourceType: isBanner ? 'banner' : 'page',
      resourceId: str(isBanner ? p['bannerId'] : p['pageId']),
    };
  }

  // System-generated in-app notification (fed by a wallet withdrawal event); the
  // recipient is the notification's subject, not an acting player.
  if (topic === 'notifications.created') {
    return {
      ...base,
      actorType: 'system',
      resourceType: 'notification',
      resourceId: str(p['notificationId']),
      after: { userId: str(p['userId']) },
    };
  }

  // Admin updated a tag rule configuration.
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
  // Admin created or deleted a tag catalog definition (the tag itself, not a
  // player assignment - see the tag.player.assigned/removed branch for that).
  if (topic === 'tag.created' || topic === 'tag.deleted') {
    return {
      ...base,
      actorType: 'admin',
      actorId: str(p['actorId']),
      resourceType: 'tag',
      resourceId: str(p['key']),
    };
  }
  // RG admin actions. `userId` = subject player (resource), `actorId` = acting admin.
  // limit.set + lifted carry a before-snapshot so the regulatory export is diffable.
  if (
    topic === 'rg.limit.set' ||
    topic === 'rg.cooling_off.activated' ||
    topic === 'rg.self_exclusion.activated' ||
    topic === 'rg.self_exclusion.lifted' ||
    topic === 'rg.cooling_off.lifted'
  ) {
    const before =
      topic === 'rg.limit.set'
        ? { amount: p['previousAmount'] ?? null, minutes: p['previousMinutes'] ?? null }
        : topic === 'rg.self_exclusion.lifted' || topic === 'rg.cooling_off.lifted'
          ? { status: 'active' }
          : null;
    return {
      ...base,
      actorType: 'admin',
      actorId: str(p['actorId']),
      resourceType: 'player',
      resourceId: str(p['userId']),
      before,
      after: p,
    };
  }

  // System-driven login block on an excluded/cooled-off player. actorType is
  // 'system' (no admin acted here) and the outcome is a failure, not the base
  // regex's default 'success' (the topic doesn't end in failed/rejected/declined).
  if (topic === 'rg.exclusion.login_blocked') {
    return {
      ...base,
      actorType: 'system',
      resourceType: 'player',
      resourceId: str(p['userId']),
      result: 'failure',
    };
  }

  // System-driven login rejection for a suspended/closed player account (Backoffice-
  // initiated block, not an admin action happening right now) - actorType 'system',
  // outcome 'failure'.
  if (topic === 'player.login_blocked') {
    return {
      ...base,
      actorType: 'system',
      resourceType: 'player',
      resourceId: str(p['userId']),
      result: 'failure',
    };
  }

  // Wallet events carry the txn ref in transactionId; surface it as resourceId so
  // a transaction reference is searchable (it otherwise stays buried in `after`).
  if (topic.startsWith('wallet.')) {
    return {
      ...base,
      actorType: 'player',
      actorId: str(p['userId']),
      resourceType: 'transaction',
      resourceId: str(p['transactionId']),
      after: p,
    };
  }

  if (typeof p['userId'] === 'string') {
    return { ...base, actorId: p['userId'], actorType: 'player' };
  }

  return base;
}

const SUBSCRIBED_TOPICS: DomainEventName[] = [
  'identity.user.registered',
  'identity.user.login',
  'identity.user.login.failed',
  'identity.user.lockout.triggered',
  'identity.user.unlocked',
  'identity.user.logout',
  'identity.user.phone_login',
  'identity.phone_otp.requested',
  'identity.phone_otp.cancelled',
  'identity.2fa.enabled',
  'identity.2fa.disabled',
  'identity.password.reset',
  'identity.email.verified',
  'identity.profile.updated',
  'identity.user.deactivated',
  'identity.user.reactivated',
  'identity.session.revoked',
  'identity.sessions.revoked_all',
  'identity.user.unauthorized_access',
  'wallet.deposit.completed',
  'wallet.withdrawal.completed',
  'wallet.withdrawal.requested',
  'wallet.withdrawal.approved',
  'wallet.withdrawal.rejected',
  'wallet.withdrawal.failed',
  'gaming.round.started',
  'gaming.round.ended',
  'chat.user.blocked',
  'chat.user.unblocked',
  'chat.user.ignored',
  'chat.user.unignored',
  'chat.private_room.created',
  'chat.private_room.deleted',
  'chat.room.created',
  'chat.room.updated',
  'chat.room.deleted',
  'chat.room.member.joined',
  'chat.room.member.left',
  'chat.room.member.kicked',
  'chat.room.member.banned',
  // chat.gift.sent
  // chat.rain.distributed
  'chat.user.mentioned',
  'compliance.limit.upserted',
  'compliance.limit.removed',
  'rg.limit.set',
  'rg.cooling_off.activated',
  'rg.self_exclusion.activated',
  'rg.self_exclusion.lifted',
  'rg.cooling_off.lifted',
  'rg.exclusion.login_blocked',
  'compliance.kyc.updated',
  'compliance.kyc.submitted',
  'compliance.kyc.reverify_required',
  'compliance.kyc.high_risk_signal_detected',
  'compliance.geo-rule.added',
  'cms.page.published',
  'cms.page.created',
  'cms.page.updated',
  'cms.page.deleted',
  'cms.banner.created',
  'cms.banner.updated',
  'cms.banner.deleted',
  'notifications.created',
  'iam.invitation.accepted',
  'iam.role.created',
  'iam.role.updated',
  'iam.role.deleted',
  'iam.role.permissions.changed',
  'iam.role.assigned',
  'iam.role.revoked',
  'tag.created',
  'tag.deleted',
  'tag.player.assigned',
  'tag.player.removed',
  'tag.rule.upserted',
  'player.level.changed',
  'player.login_blocked',
] as const;

export default {
  id: 'audit',
  register(ctx) {
    const logger = createLogger('audit');

    // Subscriptions are wired before router factories run (create-app.ts boot order),
    // so svcRef is null at registration but set before any real event arrives.
    let svcRef: AuditService | null = null;

    ctx.provideSealed(AUDIT_WRITER, (c) => {
      const svc = new AuditService(c.get(DRIZZLE), c.get(EVENT_BUS));
      return {
        record: (entry) => svc.record(entry).then(() => undefined),
        recordInTransaction: (tx, entry) =>
          svc.recordInTransaction(tx, entry).then(() => undefined),
      };
    });

    for (const topic of SUBSCRIBED_TOPICS) {
      ctx.events.on(topic, (payload) => {
        if (!svcRef || !isRecord(payload)) {
          return;
        }
        void svcRef
          .record(mapEventToRecord(topic, payload))
          .catch((err) => logger.error({ err, topic }, 'audit record failed'));
      });
    }

    ctx.routers.add('audit', (c) => {
      const svc = new AuditService(c.get(DRIZZLE), c.get(EVENT_BUS));
      svcRef = svc;
      return createAuditRouter(svc, c.get(ADMIN_GUARD));
    });
  },
} as const satisfies Plugin<CoreTokenCatalog>;

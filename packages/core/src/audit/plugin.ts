import { EVENT_BUS, DRIZZLE, ADMIN_GUARD, createLogger } from '@openora/core/server';
import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { AUDIT_WRITER, type DomainEventName } from '@openora/core/contracts';
import { AuditService, type RecordInput } from './service/audit.service.js';
import { createAuditRouter } from './router/index.js';

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
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

  // payload `userId` is the SUBJECT player here, not the actor (an admin changed it).
  if (topic === 'compliance.kyc.updated') {
    return {
      ...base,
      actorType: p['actorId'] ? 'admin' : 'system',
      actorId: str(p['actorId']),
      resourceType: 'player',
      resourceId: str(p['playerId']),
      before: { kycStatus: p['previousStatus'] ?? null },
      after: {
        kycStatus: p['status'] ?? null,
        reason: p['reason'] ?? null,
        source: p['source'] ?? null,
      },
    };
  }

  // Player submitted KYC documents. actorId = resourceId = the player (self-action),
  // both resolved by the emitter as playerId.
  if (topic === 'compliance.kyc.submitted') {
    return {
      ...base,
      actorType: 'player',
      actorId: str(p['playerId']),
      resourceType: 'player',
      resourceId: str(p['playerId']),
      after: { referenceId: p['referenceId'] ?? null, provider: p['provider'] ?? null },
    };
  }

  // System-driven re-KYC trigger. No admin actor; resource = the subject player.
  if (topic === 'compliance.kyc.reverify_required') {
    return {
      ...base,
      actorType: 'system',
      resourceType: 'player',
      resourceId: str(p['playerId']),
      after: { reason: p['reason'] ?? null },
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

  // Player requested a withdrawal (funds held). actorId = the player (resolved
  // playerId); resourceId = the withdrawal transaction.
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

  // Admin triggered a password-reset OTP send for a player. resource = the subject
  // player; actor = the admin who acted.
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

  // actorId = the resolved playerId when the caller was a player, else the raw
  // (admin) userId.
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

  // Player authenticated via SMS OTP. actorId = resource = the player; success outcome.
  if (topic === 'identity.user.phone_login') {
    return {
      ...base,
      actorType: 'player',
      actorId: str(p['playerId']),
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
  // actorId = the resolved playerId on the self-revoke path, else the acting admin's
  // raw userId (never resolved - actor is an admin, not the subject player).
  if (topic === 'identity.session.revoked' || topic === 'identity.sessions.revoked_all') {
    const isSingle = topic === 'identity.session.revoked';
    const isForced = !!p['actorId'];
    const actorId = isForced ? str(p['actorId']) : str(p['playerId']);
    return {
      ...base,
      actorType: isForced ? 'admin' : 'player',
      actorId,
      resourceType: isSingle ? 'session' : 'user',
      resourceId: isSingle ? str(p['sessionId']) : str(p['userId']),
    };
  }

  // actorId = the (un)blocking player's resolved playerId; resource = the
  // blocked/unblocked player's resolved playerId.
  if (topic === 'chat.user.blocked' || topic === 'chat.user.unblocked') {
    return {
      ...base,
      actorType: 'player',
      actorId: str(p['actorPlayerId']),
      resourceType: 'player',
      resourceId: str(p['playerId']),
    };
  }

  // actorId = the (un)ignoring player's resolved playerId; resource = the
  // ignored/unignored player's resolved playerId.
  if (topic === 'chat.user.ignored' || topic === 'chat.user.unignored') {
    return {
      ...base,
      actorType: 'player',
      actorId: str(p['actorPlayerId']),
      resourceType: 'player',
      resourceId: str(p['playerId']),
    };
  }

  // actorId = the moderator's resolved playerId; resource = the affected player in
  // that room (not player-typed - resourceId stays the raw member userId).
  if (topic === 'chat.room.member.kicked' || topic === 'chat.room.member.banned') {
    return {
      ...base,
      actorType: 'player',
      actorId: str(p['playerId']),
      resourceType: 'chat_room_member',
      resourceId: str(p['userId']),
      after: { roomId: str(p['roomId']) },
    };
  }

  // actorId = the creating/deleting player's resolved playerId; resource = the room.
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

  // actorId = the joining/leaving player's resolved playerId; resource is not
  // player-typed - resourceId stays the raw member userId.
  if (topic === 'chat.room.member.joined' || topic === 'chat.room.member.left') {
    return {
      ...base,
      actorType: 'player',
      actorId: str(p['playerId']),
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
      resourceId: str(p['playerId']),
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

  // A player sent a friend request. actorId = the requester; resourceId = the
  // friendship row; recipient carried in after so the trail shows who was notified.
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

  // A pending friend request became a friendship. actorId = whoever's action
  // triggered the accept (accepterId - see events.ts for the mutual-request case).
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
      resourceId: str(p['playerId']),
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
      resourceId: str(p['playerId']),
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
      resourceId: str(p['playerId']),
      result: 'failure',
    };
  }

  // Wallet events carry the txn ref in transactionId; surface it as resourceId so
  // a transaction reference is searchable (it otherwise stays buried in `after`).
  // actorId = the resolved playerId (the wallet owner).
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

  // Registration always precedes player-row creation (public sign-up only, no
  // admin path): actorType stays 'player' even though playerId is legitimately
  // null at emit time, before the async listener creates the row.
  if (topic === 'identity.user.registered') {
    return { ...base, actorId: str(p['playerId']), actorType: 'player' };
  }

  // Shared identity self-action topics: the same `/identity/*` endpoints serve
  // both player and admin accounts, so playerId only resolves for a player. A
  // null playerId means the account has no player row - attribute to the
  // admin's own userId instead of mislabeling them as a player.
  if (
    topic === 'identity.user.login' ||
    topic === 'identity.user.logout' ||
    topic === 'identity.2fa.enabled' ||
    topic === 'identity.2fa.disabled' ||
    topic === 'identity.password.reset' ||
    topic === 'identity.email.verified' ||
    topic === 'identity.profile.updated'
  ) {
    const playerId = p['playerId'];
    return playerId
      ? { ...base, actorId: str(playerId), actorType: 'player' }
      : { ...base, actorId: str(p['userId']), actorType: 'admin' };
  }

  // Generic player-self-action fallback (gaming rounds, chat, self-service RG
  // limits, ...): actorId = the resolved playerId.
  if (typeof p['userId'] === 'string') {
    return { ...base, actorId: str(p['playerId']), actorType: 'player' };
  }

  return base;
}

const SUBSCRIBED_TOPICS: DomainEventName[] = [
  'identity.user.registered',
  'identity.user.login',
  'identity.user.login.failed',
  'identity.user.lockout.triggered',
  'identity.user.unlocked',
  'identity.password.admin_reset_requested',
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
  'social.friend_request.sent',
  'social.friend_request.accepted',
  'social.friendship.removed',
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
        const svc = svcRef;
        void mapEventToRecord(topic, payload)
          .then((record) => svc.record(record))
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

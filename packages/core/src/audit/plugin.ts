import { definePlugin, EVENT_BUS, DRIZZLE, ADMIN_GUARD } from '@openora/core/server';
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
      after: { kycStatus: p['status'] ?? null },
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
  // RG admin actions. `userId` = subject player (resource), `actorId` = acting admin.
  // limit.set + lifted carry a before-snapshot so the regulatory export is diffable.
  if (
    topic === 'rg.limit.set' ||
    topic === 'rg.cooling_off.activated' ||
    topic === 'rg.self_exclusion.activated' ||
    topic === 'rg.self_exclusion.lifted'
  ) {
    const before =
      topic === 'rg.limit.set'
        ? { amount: p['previousAmount'] ?? null }
        : topic === 'rg.self_exclusion.lifted'
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
  // chat.message.sent is intentionally NOT audited: it is high-volume content
  // already persisted in chatMessage; the moderation/block actions are what we audit.
  'chat.user.blocked',
  'chat.user.unblocked',
  'compliance.limit.upserted',
  'compliance.limit.removed',
  'rg.limit.set',
  'rg.cooling_off.activated',
  'rg.self_exclusion.activated',
  'rg.self_exclusion.lifted',
  'rg.exclusion.login_blocked',
  'compliance.kyc.updated',
  'compliance.kyc.submitted',
  'compliance.kyc.reverify_required',
  'compliance.geo-rule.added',
  'cms.page.published',
  'iam.invitation.accepted',
  'iam.role.created',
  'iam.role.updated',
  'iam.role.deleted',
  'iam.role.permissions.changed',
  'iam.role.assigned',
  'iam.role.revoked',
  'tag.player.assigned',
  'tag.player.removed',
  'tag.rule.upserted',
] as const;

export default definePlugin({
  id: 'audit',
  register(ctx) {
    // Subscriptions are wired before router factories run (create-app.ts boot order),
    // so svcRef is null at registration but set before any real event arrives.
    let svcRef: AuditService | null = null;

    ctx.provideSealed(AUDIT_WRITER, (c) => {
      const svc = new AuditService(c.get(DRIZZLE), c.get(EVENT_BUS));
      return {
        record: (entry) => svc.record(entry).then(() => undefined),
      };
    });

    for (const topic of SUBSCRIBED_TOPICS) {
      ctx.events.on(topic, (payload) => {
        if (!svcRef || !isRecord(payload)) return;
        void svcRef.record(mapEventToRecord(topic, payload));
      });
    }

    ctx.routers.add('audit', (c) => {
      const svc = new AuditService(c.get(DRIZZLE), c.get(EVENT_BUS));
      svcRef = svc;
      return createAuditRouter(svc, c.get(ADMIN_GUARD));
    });
  },
});

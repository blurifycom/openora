import { definePlugin } from '@blurifycom/core/server';
import { EVENT_BUS } from '@blurifycom/core/server';
import { DRIZZLE } from '@blurifycom/core/server';
import { ADMIN_GUARD } from '@blurifycom/core/server';
import { AUDIT_WRITER } from '@blurifycom/core/contracts';
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
  };

  // payload `userId` is the SUBJECT player here, not the actor (an admin changed it).
  if (topic === 'compliance.kyc.updated') {
    return {
      ...base,
      actorType: 'admin',
      actorId: str(p['actorId']),
      resourceType: 'player',
      resourceId: str(p['userId']),
      before: { kycStatus: p['previousStatus'] ?? null },
      after: { kycStatus: p['status'] ?? null },
    };
  }

  // Admin-triggered game-catalogue sync. actorId = acting admin (may be absent on
  // system-triggered syncs, in which case it stays a system entry).
  if (topic === 'aggregator.sync.completed') {
    return {
      ...base,
      actorType: typeof p['actorId'] === 'string' ? 'admin' : 'system',
      actorId: str(p['actorId']),
      resourceType: 'game',
      after: { synced: p['synced'] ?? null, failed: p['failed'] ?? null },
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

// Each topic must exist in domainEventSchemas - do not invent topics here.
const SUBSCRIBED_TOPICS = [
  'identity.user.registered',
  'identity.user.login',
  'identity.user.logout',
  'identity.2fa.enabled',
  'identity.2fa.disabled',
  'identity.password.reset',
  'identity.email.verified',
  'identity.profile.updated',
  'identity.user.deactivated',
  'identity.user.reactivated',
  'wallet.deposit.completed',
  'wallet.withdrawal.completed',
  'wallet.withdrawal.requested',
  'wallet.withdrawal.approved',
  'wallet.withdrawal.rejected',
  'wallet.withdrawal.failed',
  'gaming.round.started',
  'gaming.round.ended',
  'bonus.claimed',
  // chat.message.sent is intentionally NOT audited: it is high-volume content
  // already persisted in chatMessage; the moderation/block actions are what we audit.
  'chat.user.blocked',
  'chat.user.unblocked',
  'compliance.limit.upserted',
  'compliance.limit.removed',
  'compliance.kyc.updated',
  'compliance.geo-rule.added',
  'aggregator.sync.completed',
  'cms.page.published',
  'iam.invitation.accepted',
  'iam.role.created',
  'iam.role.updated',
  'iam.role.deleted',
  'iam.role.permissions.changed',
  'iam.role.assigned',
  'iam.role.revoked',
] as const;

export default definePlugin({
  id: 'audit',
  register(ctx) {
    // Subscriptions are wired before router factories run (create-app.ts boot order),
    // so svcRef is null at registration but set before any real event arrives.
    let svcRef: AuditService | null = null;

    ctx.provide(AUDIT_WRITER, (c) => {
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

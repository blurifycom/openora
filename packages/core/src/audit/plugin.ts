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
      resourceType: 'player',
      resourceId: str(p['userId']),
      before: { kycStatus: p['previousStatus'] ?? null },
      after: { kycStatus: p['status'] ?? null },
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
      before: carriesMatrix ? (p['before'] ?? null) : null,
      after: carriesMatrix
        ? (p['after'] ?? null)
        : carriesTarget
          ? { userId: str(p['userId']) }
          : null,
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
  'wallet.deposit.completed',
  'wallet.withdrawal.completed',
  'gaming.round.started',
  'gaming.round.ended',
  'bonus.claimed',
  'compliance.limit.upserted',
  'compliance.limit.removed',
  'compliance.kyc.updated',
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

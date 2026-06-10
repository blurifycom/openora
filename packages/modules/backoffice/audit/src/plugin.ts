import { definePlugin } from '@oss/plugin-host';
import { EVENT_BUS, getCurrentTenantId } from '@oss/core';
import { DRIZZLE } from '@oss/db';
import { ADMIN_GUARD } from '@oss/auth';
import { AUDIT_WRITER } from '@oss/adapters';
import { AuditService, type RecordInput } from './service/audit.service.js';
import { createAuditRouter } from './router/index.js';

// Pure mapping: domain event topic + payload -> RecordInput.
function mapEventToRecord(topic: string, payload: unknown, tenantId: string): RecordInput {
  const p = payload as Record<string, unknown>;

  const base: RecordInput = {
    tenantId,
    actorType: 'system',
    action: topic,
    resourceType: topic.split('.')[0] ?? topic,
    resourceId: null,
    after: p,
  };

  if (typeof p['userId'] === 'string') {
    return { ...base, actorId: p['userId'], actorType: 'player' };
  }

  return base;
}

// Topics that exist in domainEventSchemas. Do not invent new ones.
const SUBSCRIBED_TOPICS = [
  'identity.user.registered',
  'identity.user.login',
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
  'cms.page.published',
  'iam.invitation.accepted',
] as const;

export default definePlugin({
  id: 'audit',
  register(ctx) {
    // Mutable ref set by the router factory after the container is resolved.
    // Event handlers close over this ref so they can call the service once it is
    // built. In normal boot order (create-app.ts) event subscriptions are wired
    // to the bus BEFORE router factories run, so the ref is null when registered
    // but populated before any real event can arrive.
    let svcRef: AuditService | null = null;

    // Bind the AUDIT_WRITER port so other modules / overlays can record audit
    // entries without importing this module's internals.
    ctx.provide(AUDIT_WRITER, (c) => {
      const svc = new AuditService(c.get(DRIZZLE), c.get(EVENT_BUS));
      return {
        record: (entry) => svc.record(entry).then(() => undefined),
      };
    });

    // Register event subscribers. Handlers are wired to the live EventBus by
    // create-app.ts after all plugins have registered. At event-fire time the
    // router factory will have already run and svcRef will be populated.
    for (const topic of SUBSCRIBED_TOPICS) {
      ctx.events.on(topic, (payload) => {
        if (!svcRef) return;
        const tenantId = getCurrentTenantId() ?? 'default';
        void svcRef.record(mapEventToRecord(topic, payload, tenantId));
      });
    }

    // Router factory - runs after all plugins register, giving us the resolved
    // container. Sets svcRef so the event handlers above become functional.
    ctx.routers.add('audit', (c) => {
      const svc = new AuditService(c.get(DRIZZLE), c.get(EVENT_BUS));
      svcRef = svc;
      return createAuditRouter(svc, c.get(ADMIN_GUARD));
    });
  },
});

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { ClientMeta } from '@openora/core/contracts';

export type RequestAuditTrail = {
  grant?: { userId: string; resource: string; action: string } & ClientMeta;
  writtenFor: Set<string>;
  published: Set<string>;
};

export type RequestContext = {
  userId?: string;
  traceId: string;
  clientMeta?: ClientMeta;
  audit?: RequestAuditTrail;
  correlationId?: string;
};

export type RequestStorage = AsyncLocalStorage<RequestContext>;

export const requestStorage: RequestStorage = new AsyncLocalStorage<RequestContext>();

export function getCurrentRequestContext(): RequestContext | undefined {
  return requestStorage.getStore();
}

export function getCurrentTraceId(): string | undefined {
  return requestStorage.getStore()?.traceId;
}

export function getCurrentCorrelationId(): string | undefined {
  return requestStorage.getStore()?.correlationId;
}

export function getCurrentClientMeta(): ClientMeta {
  return requestStorage.getStore()?.clientMeta ?? { ip: null, userAgent: null };
}

export function withRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return requestStorage.run(ctx, fn);
}

function auditTrail(): RequestAuditTrail | undefined {
  const store = requestStorage.getStore();
  return store && (store.audit ??= { writtenFor: new Set(), published: new Set() });
}

export function withCorrelationId<T>(correlationId: string, fn: () => T): T {
  const store = requestStorage.getStore();
  return requestStorage.run(
    store
      ? { ...store, audit: auditTrail(), correlationId }
      : { traceId: randomUUID(), correlationId },
    fn,
  );
}

export function getRequestAuditTrail(): RequestAuditTrail | undefined {
  return requestStorage.getStore()?.audit;
}

export function noteGrantedPermission(grant: NonNullable<RequestAuditTrail['grant']>): void {
  const trail = auditTrail();
  if (trail && (!trail.grant || (trail.grant.action === 'view' && grant.action !== 'view'))) {
    trail.grant = grant;
  }
}

export function noteAuditWrite(actorId: string | null | undefined): void {
  if (actorId) {
    auditTrail()?.writtenFor.add(actorId);
  }
}

export function notePublishedTopic(topic: string): void {
  auditTrail()?.published.add(topic);
}

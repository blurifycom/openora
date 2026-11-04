import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { ClientMeta } from '@openora/core/contracts';

/** What the active request has done that bears on its audit trail; read by the admin-mutation fallback. */
export type RequestAuditTrail = {
  /** The first permission an admin guard granted (a `view` grant yields to any later one), with the caller it granted it to. */
  grant?: { userId: string; resource: string; action: string } & ClientMeta;
  /** The actors an audit row was appended for. */
  writtenFor: Set<string>;
  /** Topics published, `emit` and `emitInTransaction` alike. A best-effort `emit` can be lost with the broker, an accepted gap: counting it only would double-record every route audited through one. */
  published: Set<string>;
};

export type RequestContext = {
  userId?: string;
  traceId: string;
  clientMeta?: ClientMeta;
  audit?: RequestAuditTrail;
  /** The id every audit row and event written in this context is correlated under, e.g. one agent proposal's execution. */
  correlationId?: string;
};

export type RequestStorage = AsyncLocalStorage<RequestContext>;

export const requestStorage: RequestStorage = new AsyncLocalStorage<RequestContext>();

export function getCurrentRequestContext(): RequestContext | undefined {
  return requestStorage.getStore();
}

/** The active request's trace id for event correlation, or undefined on system/background paths. */
export function getCurrentTraceId(): string | undefined {
  return requestStorage.getStore()?.traceId;
}

/** The correlation id the active context opened with, or undefined when none was set. */
export function getCurrentCorrelationId(): string | undefined {
  return requestStorage.getStore()?.correlationId;
}

/** The active request's caller metadata, for an event emitted from a callback the request cannot thread it into. */
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

/**
 * Runs `fn` under `correlationId`. Inside a request it keeps the request's trace id, caller
 * metadata and audit trail (shared, so what `fn` writes still counts for the request); outside
 * one - a job, a startup task - it opens a context of its own with a fresh trace id.
 */
export function withCorrelationId<T>(correlationId: string, fn: () => T): T {
  const store = requestStorage.getStore();
  return requestStorage.run(
    store
      ? { ...store, audit: auditTrail(), correlationId }
      : { traceId: randomUUID(), correlationId },
    fn,
  );
}

/** The active request's audit trail, or undefined on system/background paths. */
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

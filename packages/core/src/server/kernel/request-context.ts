import { AsyncLocalStorage } from 'node:async_hooks';
import type { ClientMeta } from '@openora/core/contracts';

export type RequestContext = {
  userId?: string;
  traceId: string;
  clientMeta?: ClientMeta;
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

/** The active request's caller metadata, for an event emitted from a callback the request cannot thread it into. */
export function getCurrentClientMeta(): ClientMeta {
  return requestStorage.getStore()?.clientMeta ?? { ip: null, userAgent: null };
}

export function withRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return requestStorage.run(ctx, fn);
}

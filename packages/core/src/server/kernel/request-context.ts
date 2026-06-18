import { AsyncLocalStorage } from 'node:async_hooks';

export type RequestContext = {
  userId?: string;
  traceId: string;
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

export function withRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return requestStorage.run(ctx, fn);
}

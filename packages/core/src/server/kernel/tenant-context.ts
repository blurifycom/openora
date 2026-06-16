import { AsyncLocalStorage } from 'node:async_hooks';

export type TenantContext = {
  userId: string;
  tenantId: string;
  traceId: string;
};

export type TenantStorage = AsyncLocalStorage<TenantContext>;

export const tenantStorage: TenantStorage = new AsyncLocalStorage<TenantContext>();

export function getCurrentTenant(): TenantContext | undefined {
  return tenantStorage.getStore();
}

/**
 * The active request's tenant id from the AsyncLocalStorage frame, or undefined
 * when there is no tenant context (system/background paths). This is the SAME
 * value `create-app` pins as the RLS `app.tenant_id` GUC (ADR-0018), so a service
 * stamping it on an insert satisfies the table's WITH CHECK policy. It is the same
 * tenant `getTenantId(context)` returns - both derive from the verified session,
 * never from a client header. Use this accessor inside a service (no oRPC context);
 * use `getTenantId(context)` in a router handler.
 */
export function getCurrentTenantId(): string | undefined {
  return tenantStorage.getStore()?.tenantId;
}

export function withTenant<T>(ctx: TenantContext, fn: () => T): T {
  return tenantStorage.run(ctx, fn);
}

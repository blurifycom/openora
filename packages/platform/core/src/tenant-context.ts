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

export function withTenant<T>(ctx: TenantContext, fn: () => T): T {
  return tenantStorage.run(ctx, fn);
}

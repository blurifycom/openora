export type { TenantContext, TenantStorage } from './tenant-context.js';
export { tenantStorage, getCurrentTenant, withTenant } from './tenant-context.js';

export type { EventBus, EventHandler } from './event-bus.js';
export { EVENT_BUS, InMemoryBroker, createEventBus } from './event-bus.js';

export { Container } from './container.js';
export type { Factory } from './container.js';

export { createLogger } from './logger.js';

export { getUserId, getTenantId } from './router-utils.js';
export type { OssContext } from './router-utils.js';
export { createDomainError } from './domain-error.js';
export { mapErrors } from './orpc-error-map.js';

// T0 PlatformConfig loader (see ADR-0013, Tier 0). The Zod schema + types live
// in @oss/shared-schemas; the file-system loader lives here.
export {
  loadPlatformConfig,
  resolvePlatformConfigPath,
} from './platform-config-loader.js';

export type { RequestContext, RequestStorage } from './request-context.js';
export {
  requestStorage,
  getCurrentRequestContext,
  getCurrentTraceId,
  withRequestContext,
} from './request-context.js';

export type { EventBus, EventHandler } from './event-bus.js';
export { EVENT_BUS, InMemoryBroker, createEventBus } from './event-bus.js';

export { InProcessJobQueue } from './job-queue.js';
export { InProcessRealtimeTransport } from './realtime-transport.js';
export { SseClientAuthorizer, type SseClientAuthorizerOptions } from './realtime-authorizer.js';

export { Container } from './container.js';
export type { Factory } from './container.js';

export { createLogger } from './logger.js';

export { getUserId } from './router-utils.js';
export type { OssContext, AuthContext, NodeHeaders } from './router-utils.js';
export {
  createDomainError,
  makeNotFoundError,
  makeOwnershipError,
  makeConflictError,
} from './domain-error.js';
export { mapErrors } from './orpc-error-map.js';

export { assertOwnership } from './ownership.js';
export { serializeRow } from './serialize-row.js';
export type { SerializedRow } from './serialize-row.js';
export { createEventStreamGenerator } from './event-stream.js';
export type { EventStreamOptions } from './event-stream.js';

// T0 PlatformConfig loader. See ADR-0013 Tier 0.
export { loadPlatformConfig, resolvePlatformConfigPath } from './platform-config-loader.js';

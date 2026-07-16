// @openora/core/testing - test-only doubles for the seams that require a durable
// binding in production (ADR-0030). `createApp` no longer ships these on the
// production path; `bootTestApp` (@openora/testing) and core's own unit tests bind
// them explicitly via a `configure` callback so the suite still runs with zero infra.
export { InMemoryBroker } from './fakes/event-bus.js';
export { InProcessRateLimiter } from './fakes/rate-limiter.js';
export { InProcessCache } from './fakes/cache.js';
export { InProcessJobQueue } from './fakes/job-queue.js';
export { InProcessRealtimeTransport } from './fakes/realtime-transport.js';
export {
  SseClientAuthorizer,
  type SseClientAuthorizerOptions,
} from './fakes/realtime-authorizer.js';
export {
  createTestDb,
  createTestRedis,
  redisUrlForWorker,
  waitForConsumerGroup,
  type Migration,
  type TestDb,
  type TestRedis,
} from './real-infra.js';

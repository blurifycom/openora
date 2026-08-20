export { DrizzleService, DRIZZLE } from './drizzle.service.js';
export { createDrizzleDb, type DrizzleDb, type DrizzleTx } from './drizzle.js';
export {
  findOneOrThrow,
  pageToOffset,
  withAdvisoryXactLock,
  moneyToNumber,
  moneyEquals,
  moneyCompare,
  moneyScaleBy,
  mapConcurrent,
} from './query-helpers.js';

// Transactional outbox - writer binds atomically with the state change; relay publishes to MESSAGE_BROKER. See ADR-0016.
export { eventOutbox, type EventOutboxRow } from './outbox/schema.js';
export { DrizzleOutboxWriter } from './outbox/writer.js';
export { OutboxRelay, type OutboxRelayOptions } from './outbox/relay.js';

// @openora/core/server/orm is a framework-free leaf so drizzle-kit can bundle schemas without
// pulling in DrizzleService; cross-workspace consumers use it to share the physical drizzle-orm copy.
export * as orm from './orm.js';

export { DrizzleService, DRIZZLE } from './drizzle.service.js';
export { createDrizzleDb, type DrizzleDb } from './drizzle.js';
export { findOneOrThrow, pageToOffset } from './query-helpers.js';

// Transactional outbox: the durable bridge that lets domain events survive a
// process boundary. The writer is the default OUTBOX binding; the relay publishes
// pending rows to the MESSAGE_BROKER. See ADR-0016.
export { eventOutbox, type EventOutboxRow } from './outbox/schema.js';
export { DrizzleOutboxWriter } from './outbox/writer.js';
export { OutboxRelay, type OutboxRelayOptions } from './outbox/relay.js';

// The drizzle surface (tables + operators) lives at the `@oss/core/server/orm` subpath -
// a framework-free leaf so drizzle-kit can bundle module schemas without pulling
// in DrizzleService. Cross-workspace consumers (eg a linked consumer via `link:`)
// import drizzle from there to share @oss/core/server's single physical drizzle-orm copy.
export * as orm from './orm.js';

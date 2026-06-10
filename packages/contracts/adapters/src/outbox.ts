// Transactional-outbox seam. A money/critical service, INSIDE its db.transaction,
// records the event through this port; the row commits atomically with the state
// change. A relay then publishes it to the MESSAGE_BROKER after commit, closing
// the gap where a crash between "state committed" and "event published" would
// otherwise lose the event. This is the primitive that makes cross-service,
// at-least-once domain events reliable - and the reason a module can be extracted
// to its own process without dropping events. See ADR-0016.
//
// `tx` is the active transaction handle, typed `unknown` here to keep @oss/adapters
// ORM-free; the Drizzle implementation in @oss/db narrows it. Services never touch
// this port directly - they call EventBus.emitInTransaction(tx, ...), which builds
// the envelope and delegates here.
import { createToken, type Token } from './token.js';
import type { EventEnvelope } from './broker.js';

export type OutboxWriter = {
  write(tx: unknown, envelope: EventEnvelope): Promise<void>;
};

export const OUTBOX: Token<OutboxWriter> = createToken('OUTBOX');

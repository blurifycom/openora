import type { OutboxWriter, EventEnvelope } from '@oss/adapters';
import { eventOutbox } from './schema.js';
import type { DrizzleDb } from '../drizzle.js';

// Default OUTBOX implementation: inserts the envelope into event_outbox using the
// caller's transaction handle, so the row commits atomically with the state
// change. onConflictDoNothing makes a retried emit (same eventId) a no-op.
export class DrizzleOutboxWriter implements OutboxWriter {
  async write(tx: unknown, envelope: EventEnvelope): Promise<void> {
    const db = tx as DrizzleDb;
    await db
      .insert(eventOutbox)
      .values({
        eventId: envelope.eventId,
        topic: envelope.topic,
        payload: envelope.payload as Record<string, unknown>,
        schemaVersion: envelope.schemaVersion,
        tenantId: envelope.tenantId ?? null,
        traceId: envelope.traceId ?? null,
        orderingKey: envelope.orderingKey ?? null,
        occurredAt: new Date(envelope.occurredAt),
      })
      .onConflictDoNothing();
  }
}

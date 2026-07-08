import type { OutboxWriter, EventEnvelope } from '@openora/core/contracts';
import { eventOutbox } from './schema.js';
import type { DrizzleDb } from '../drizzle.js';

// onConflictDoNothing makes a retried emit (same eventId) a no-op.
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
        traceId: envelope.traceId ?? null,
        orderingKey: envelope.orderingKey ?? null,
        occurredAt: new Date(envelope.occurredAt),
      })
      .onConflictDoNothing();
  }
}

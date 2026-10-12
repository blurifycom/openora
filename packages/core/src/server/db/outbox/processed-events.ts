import { and, eq } from 'drizzle-orm';
import type { ProcessedEventLog } from '../../kernel/event-bus.js';
import { processedEvents } from './schema.js';
import type { DrizzleDb } from '../drizzle.js';

/** Postgres-backed `ProcessedEventLog`; rows are pruned by the `OutboxRelay`. */
export class DrizzleProcessedEventLog implements ProcessedEventLog {
  constructor(private readonly db: DrizzleDb) {}

  async has(eventId: string, consumer: string): Promise<boolean> {
    const [row] = await this.db
      .select({ eventId: processedEvents.eventId })
      .from(processedEvents)
      .where(and(eq(processedEvents.eventId, eventId), eq(processedEvents.consumer, consumer)))
      .limit(1);
    return row !== undefined;
  }

  async record(eventId: string, consumer: string): Promise<void> {
    await this.db.insert(processedEvents).values({ eventId, consumer }).onConflictDoNothing();
  }
}

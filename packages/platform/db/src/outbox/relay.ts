import type { MessageBrokerAdapter, EventEnvelope } from '@oss/adapters';
import { asc, eq, isNull } from 'drizzle-orm';
import { eventOutbox } from './schema.js';
import type { DrizzleDb } from '../drizzle.js';

export interface OutboxRelayOptions {
  intervalMs?: number; // poll cadence; default 1000
  batchSize?: number; // rows per drain; default 100
  onError?: (err: unknown) => void;
}

// Publishes pending outbox rows to the MESSAGE_BROKER. Runs as a background poll
// loop (start/stop) and is also drainable on demand (drainOnce) for tests and for
// a synchronous flush. A row is marked published only AFTER broker.publish
// resolves, so a crash mid-publish leaves it pending and it is retried -
// at-least-once; consumers dedup on eventId.
export class OutboxRelay {
  private timer: ReturnType<typeof setInterval> | undefined;
  private draining = false;

  constructor(
    private readonly db: DrizzleDb,
    private readonly broker: MessageBrokerAdapter,
    private readonly opts: OutboxRelayOptions = {},
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.drainSafe(), this.opts.intervalMs ?? 1000);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    while (this.draining) await new Promise((r) => setTimeout(r, 10));
  }

  private async drainSafe(): Promise<void> {
    try {
      await this.drainOnce();
    } catch (err) {
      this.opts.onError?.(err);
    }
  }

  // Publish one batch of pending rows. Returns how many were published. Reentrant-
  // safe: a second call while a drain is in flight is a no-op.
  async drainOnce(): Promise<number> {
    if (this.draining) return 0;
    this.draining = true;
    try {
      const batch = await this.db
        .select()
        .from(eventOutbox)
        .where(isNull(eventOutbox.publishedAt))
        .orderBy(asc(eventOutbox.occurredAt))
        .limit(this.opts.batchSize ?? 100);

      let published = 0;
      for (const row of batch) {
        const envelope: EventEnvelope = {
          eventId: row.eventId,
          topic: row.topic,
          payload: row.payload,
          occurredAt: row.occurredAt.toISOString(),
          schemaVersion: row.schemaVersion,
          ...(row.tenantId ? { tenantId: row.tenantId } : {}),
          ...(row.traceId ? { traceId: row.traceId } : {}),
          ...(row.orderingKey ? { orderingKey: row.orderingKey } : {}),
        };
        await this.broker.publish(envelope);
        await this.db
          .update(eventOutbox)
          .set({ publishedAt: new Date() })
          .where(eq(eventOutbox.eventId, row.eventId));
        published += 1;
      }
      return published;
    } finally {
      this.draining = false;
    }
  }
}

import type { MessageBrokerAdapter, EventEnvelope } from '@openora/core/contracts';
import { asc, eq, isNull } from 'drizzle-orm';
import { eventOutbox } from './schema.js';
import type { DrizzleDb } from '../drizzle.js';

export type OutboxRelayOptions = {
  intervalMs?: number; // poll cadence; default 1000
  batchSize?: number; // rows per drain; default 100
  onError?: (err: unknown) => void;
};

/**
 * Publishes pending `event_outbox` rows to the `MESSAGE_BROKER`. Runs as a
 * background poll loop (`start`/`stop`) and is also drainable on demand
 * (`drainOnce`) for tests or a synchronous flush. A row is marked published
 * only AFTER `broker.publish` resolves, so a crash mid-publish leaves it
 * pending and it is retried - at-least-once delivery; consumers dedup on
 * `eventId`.
 *
 * ponytail: claim-then-publish (no `claimed_at` migration) - the SKIP LOCKED
 * select commits in its own short transaction, then each row publishes and is
 * marked in its own transaction outside that lock, so a publish failure only
 * retries the failing row. The tradeoff: two relays on the same tick can both
 * grab a row - fine under at-least-once (consumers dedup on `eventId`); add a
 * `claimed_at` claim-update if that ever needs closing.
 */
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
      const batch = await this.db.transaction((txn) =>
        txn
          .select()
          .from(eventOutbox)
          .where(isNull(eventOutbox.publishedAt))
          .orderBy(asc(eventOutbox.occurredAt))
          .limit(this.opts.batchSize ?? 100)
          .for('update', { skipLocked: true }),
      );

      let published = 0;
      for (const row of batch) {
        const envelope: EventEnvelope = {
          eventId: row.eventId,
          topic: row.topic,
          payload: row.payload,
          occurredAt: row.occurredAt.toISOString(),
          schemaVersion: row.schemaVersion,
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

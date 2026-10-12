import type { MessageBrokerAdapter, EventEnvelope } from '@openora/core/contracts';
import { and, asc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { EVENT_RETENTION_MS } from '../../kernel/event-bus.js';
import { eventOutbox, processedEvents, type EventOutboxRow } from './schema.js';
import type { DrizzleDb } from '../drizzle.js';

// A claimed row whose relay died mid-publish becomes claimable again after this.
const CLAIM_LEASE_MS = 30_000;
const PRUNE_INTERVAL_MS = 60 * 60_000;

export type OutboxRelayOptions = {
  intervalMs?: number; // poll cadence; default 200
  batchSize?: number; // rows per drain; default 100
  onError?: (err: unknown) => void;
};

function toEnvelope(row: EventOutboxRow): EventEnvelope {
  return {
    eventId: row.eventId,
    topic: row.topic,
    payload: row.payload,
    occurredAt: row.occurredAt.toISOString(),
    schemaVersion: row.schemaVersion,
    ...(row.traceId ? { traceId: row.traceId } : {}),
    ...(row.orderingKey ? { orderingKey: row.orderingKey } : {}),
  };
}

/**
 * Publishes pending `event_outbox` rows to the `MESSAGE_BROKER`. Runs as a
 * background poll loop (`start`/`stop`) and is also drainable on demand
 * (`drainOnce`) for tests or a synchronous flush.
 *
 * Each drain atomically claims a batch in one `UPDATE ... WHERE event_id IN
 * (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING`, stamping `claimed_at`, so
 * concurrent relays (one per replica) never claim the same row inside its lease.
 * A row is marked published only AFTER `broker.publish` resolves; a failing row
 * is reported to `onError`, its lease released for the next tick, and the rest of
 * the batch carries on. A relay that dies mid-publish leaves its rows claimed until
 * the lease expires, then another relay republishes them - at-least-once delivery,
 * deduped downstream by `processed_events`.
 *
 * The same loop prunes published outbox rows and `processed_events` rows older
 * than `EVENT_RETENTION_MS`, at most once an hour per replica.
 *
 * ponytail: polls every 200ms per replica (an indexed, usually-empty claim). Swap
 * the poll for LISTEN/NOTIFY if the idle query load or the publish latency matters.
 */
export class OutboxRelay {
  private timer: ReturnType<typeof setInterval> | undefined;
  private draining = false;
  private lastPruneAt = 0;

  constructor(
    private readonly db: DrizzleDb,
    private readonly broker: MessageBrokerAdapter,
    private readonly opts: OutboxRelayOptions = {},
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => void this.drainOnce(), this.opts.intervalMs ?? 200);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    while (this.draining) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  // Publish one claimed batch. Returns how many rows were published. Reentrant-safe:
  // a second call while a drain is in flight is a no-op. Never throws - every failure
  // goes to `onError`.
  async drainOnce(): Promise<number> {
    if (this.draining) {
      return 0;
    }
    this.draining = true;
    try {
      await this.pruneIfDue();
      const batch = await this.claimBatch();
      let published = 0;
      for (const row of batch) {
        if (await this.publishRow(row)) {
          published += 1;
        }
      }
      return published;
    } catch (err) {
      this.opts.onError?.(err);
      return 0;
    } finally {
      this.draining = false;
    }
  }

  private async claimBatch(): Promise<EventOutboxRow[]> {
    const leaseExpiredBefore = new Date(Date.now() - CLAIM_LEASE_MS);
    const claimable = this.db
      .select({ eventId: eventOutbox.eventId })
      .from(eventOutbox)
      .where(
        and(
          isNull(eventOutbox.publishedAt),
          or(isNull(eventOutbox.claimedAt), lt(eventOutbox.claimedAt, leaseExpiredBefore)),
        ),
      )
      .orderBy(asc(eventOutbox.occurredAt))
      .limit(this.opts.batchSize ?? 100)
      .for('update', { skipLocked: true });
    const rows = await this.db
      .update(eventOutbox)
      .set({ claimedAt: sql`now()`, attempts: sql`${eventOutbox.attempts} + 1` })
      .where(inArray(eventOutbox.eventId, claimable))
      .returning();
    return rows.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  }

  private async publishRow(row: EventOutboxRow): Promise<boolean> {
    try {
      await this.broker.publish(toEnvelope(row));
      await this.db
        .update(eventOutbox)
        .set({ publishedAt: new Date() })
        .where(eq(eventOutbox.eventId, row.eventId));
      return true;
    } catch (err) {
      this.opts.onError?.(err);
      await this.db
        .update(eventOutbox)
        .set({ claimedAt: null })
        .where(eq(eventOutbox.eventId, row.eventId))
        .catch((releaseErr: unknown) => this.opts.onError?.(releaseErr));
      return false;
    }
  }

  private async pruneIfDue(): Promise<void> {
    if (Date.now() - this.lastPruneAt < PRUNE_INTERVAL_MS) {
      return;
    }
    this.lastPruneAt = Date.now();
    const cutoff = new Date(Date.now() - EVENT_RETENTION_MS);
    try {
      await this.db.delete(eventOutbox).where(lt(eventOutbox.publishedAt, cutoff));
      await this.db.delete(processedEvents).where(lt(processedEvents.processedAt, cutoff));
    } catch (err) {
      this.opts.onError?.(err);
    }
  }
}

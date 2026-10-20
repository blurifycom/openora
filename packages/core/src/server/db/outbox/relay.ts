import type { MessageBrokerAdapter, EventEnvelope } from '@openora/core/contracts';
import { and, asc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { EVENT_RETENTION_MS } from '../../kernel/event-bus.js';
import { eventOutbox, processedEvents, type EventOutboxRow } from './schema.js';
import type { DrizzleDb } from '../drizzle.js';

// A claimed row whose relay died mid-publish becomes claimable again after this.
const CLAIM_LEASE_MS = 30_000;
const PRUNE_INTERVAL_MS = 60 * 60_000;
// Dedupe records outlive the stream entries they guard: the broker only redelivers an entry
// younger than EVENT_RETENTION_MS (an older pending one is dead-lettered), and a record is
// written after its entry, so a day's margin keeps every redeliverable entry deduped.
const PROCESSED_EVENTS_RETENTION_MS = EVENT_RETENTION_MS + 24 * 60 * 60_000;
// A batch stops publishing once this much of its lease is spent and hands the rest back, so
// another relay can't reclaim and republish rows this one is still working through.
const PUBLISH_BUDGET_MS = CLAIM_LEASE_MS / 2;

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
 * The same loop prunes published outbox rows older than `EVENT_RETENTION_MS` (and
 * `processed_events` a day later), at most once an hour per replica.
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
    this.timer = setInterval(() => void this.drainUntilIdle(), this.opts.intervalMs ?? 200);
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

  // Keeps draining while batches come back full, so a backlog clears at publish speed
  // instead of one batch per tick. A no-op while another drain is in flight.
  private async drainUntilIdle(): Promise<void> {
    const batchSize = this.opts.batchSize ?? 100;
    let published: number;
    do {
      published = await this.drainOnce();
    } while (this.timer && published === batchSize);
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
      const deadline = Date.now() + PUBLISH_BUDGET_MS;
      const published: EventOutboxRow['eventId'][] = [];
      const unsent: EventOutboxRow['eventId'][] = [];
      for (const row of batch) {
        if (Date.now() > deadline) {
          unsent.push(row.eventId);
        } else if (await this.publishRow(row)) {
          published.push(row.eventId);
        }
      }
      if (published.length > 0) {
        await this.db
          .update(eventOutbox)
          .set({ publishedAt: sql`now()` })
          .where(inArray(eventOutbox.eventId, published));
      }
      if (unsent.length > 0) {
        await this.db
          .update(eventOutbox)
          .set({ claimedAt: null })
          .where(inArray(eventOutbox.eventId, unsent));
      }
      return published.length;
    } catch (err) {
      this.opts.onError?.(err);
      return 0;
    } finally {
      this.draining = false;
    }
  }

  private async claimBatch(): Promise<EventOutboxRow[]> {
    // DB clock on both sides of the lease (claimed_at is stamped with now()), so replica
    // clock skew cannot steal or strand a live claim.
    const leaseExpiredBefore = sql`now() - ${CLAIM_LEASE_MS} * interval '1 millisecond'`;
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
    try {
      await this.db
        .delete(eventOutbox)
        .where(lt(eventOutbox.publishedAt, new Date(Date.now() - EVENT_RETENTION_MS)));
      await this.db
        .delete(processedEvents)
        .where(
          lt(processedEvents.processedAt, new Date(Date.now() - PROCESSED_EVENTS_RETENTION_MS)),
        );
    } catch (err) {
      this.opts.onError?.(err);
    }
  }
}

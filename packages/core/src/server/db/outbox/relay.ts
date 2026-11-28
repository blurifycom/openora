import type { MessageBrokerAdapter, EventEnvelope } from '@openora/core/contracts';
import { and, asc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { createLogger } from '../../kernel/logger.js';
import { EVENT_RETENTION_MS } from '../../kernel/event-bus.js';
import { eventOutbox, processedEvents, type EventOutboxRow } from './schema.js';
import type { DrizzleDb } from '../drizzle.js';

const CLAIM_LEASE_MS = 30_000;
const PRUNE_INTERVAL_MS = 60 * 60_000;
const PROCESSED_EVENTS_RETENTION_MS = EVENT_RETENTION_MS + 24 * 60 * 60_000;
const PUBLISH_BUDGET_MS = CLAIM_LEASE_MS / 2;
const LAG_CHECK_INTERVAL_MS = 60_000;
const LAG_THRESHOLD_MS = 60_000;

const logger = createLogger('outbox-relay');

type EventOutboxBacklog = { pending: number; oldestPendingAgeMs: number };

async function eventOutboxBacklog(db: DrizzleDb): Promise<EventOutboxBacklog> {
  const result = await db.execute<{ pending: number; oldest_pending_age_ms: number | null }>(sql`
    SELECT count(*)::int AS pending,
           (extract(epoch FROM now() - min(occurred_at)) * 1000)::float8 AS oldest_pending_age_ms
    FROM ${eventOutbox}
    WHERE ${isNull(eventOutbox.publishedAt)}
  `);
  const row = result.rows[0];
  return { pending: row?.pending ?? 0, oldestPendingAgeMs: row?.oldest_pending_age_ms ?? 0 };
}

export type OutboxRelayOptions = {
  intervalMs?: number;
  batchSize?: number;
  onError?: (err: unknown) => void;
};

export function toEnvelope(row: EventOutboxRow): EventEnvelope {
  return {
    eventId: row.eventId,
    topic: row.topic,
    payload: row.payload,
    occurredAt: row.occurredAt.toISOString(),
    schemaVersion: row.schemaVersion,
    ...(row.traceId ? { traceId: row.traceId } : {}),
    ...(row.correlationId ? { correlationId: row.correlationId } : {}),
    ...(row.orderingKey ? { orderingKey: row.orderingKey } : {}),
  };
}

export async function oldestUnrelayedEvent(
  db: DrizzleDb,
): Promise<Pick<EventOutboxRow, 'eventId' | 'occurredAt'> | undefined> {
  const [row] = await db
    .select({ eventId: eventOutbox.eventId, occurredAt: eventOutbox.occurredAt })
    .from(eventOutbox)
    .where(isNull(eventOutbox.publishedAt))
    .orderBy(asc(eventOutbox.occurredAt))
    .limit(1);
  return row;
}

export class OutboxRelay {
  private timer: ReturnType<typeof setInterval> | undefined;
  private draining = false;
  private lastPruneAt = 0;
  private lastLagCheckAt = 0;

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

  private async drainUntilIdle(): Promise<void> {
    const batchSize = this.opts.batchSize ?? 100;
    let published: number;
    do {
      published = await this.drainOnce();
    } while (this.timer && published === batchSize);
  }

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
      await this.reportLagIfDue();
      this.draining = false;
    }
  }

  private async claimBatch(): Promise<EventOutboxRow[]> {
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
      .orderBy(asc(eventOutbox.occurredAt), sql`${eventOutbox.seq} asc nulls first`)
      .limit(this.opts.batchSize ?? 100)
      .for('update', { skipLocked: true });
    const rows = await this.db
      .update(eventOutbox)
      .set({ claimedAt: sql`now()`, attempts: sql`${eventOutbox.attempts} + 1` })
      .where(inArray(eventOutbox.eventId, claimable))
      .returning();
    return rows.sort(
      (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || (a.seq ?? -1) - (b.seq ?? -1),
    );
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

  private async reportLagIfDue(): Promise<void> {
    if (Date.now() - this.lastLagCheckAt < LAG_CHECK_INTERVAL_MS) {
      return;
    }
    this.lastLagCheckAt = Date.now();
    try {
      const backlog = await eventOutboxBacklog(this.db);
      if (backlog.oldestPendingAgeMs > LAG_THRESHOLD_MS) {
        logger.warn(
          { pending: backlog.pending, oldestPendingAgeMs: Math.round(backlog.oldestPendingAgeMs) },
          'event outbox lagging',
        );
      }
    } catch (err) {
      logger.error({ err }, 'event outbox lag check failed');
      this.opts.onError?.(err);
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

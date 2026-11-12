import * as z from 'zod';
import { auditOutbox, createLogger, type DrizzleDb } from '@openora/core/server';
import { and, asc, inArray, sql } from 'drizzle-orm';
import { appendAuditEntries, OutboxEntrySchema, type ShippableEntry } from './audit.service.js';

const BATCH_SIZE = 1_000;
const SHIPPER_LOCK_KEY = 'audit_shipper';
const DEFAULT_INTERVAL_MS = 200;
const MAX_BACKOFF_MS = 5_000;

const log = createLogger('audit-shipper');

type Rejection = { outboxId: number; eventId: string; error: string };

const CHAINED_WITH_OTHER_CONTENT = 'event_id already chained with different content';

/**
 * Moves one batch of `audit_outbox` rows into the hash chain, oldest first, in one transaction
 * that holds the shipper lock, so one shipper per database ships at a time; returns null when
 * another holds it and `wait` is false. A row the chain cannot take as it is moves to
 * `audit_outbox_rejected`, copied unchanged with the reason, and the rest ship: an entry that fails
 * its schema, or one whose event id the chain already holds with other content (a forged or
 * colliding row), which is never dropped as a duplicate. The rows are deleted in the same
 * transaction as the append, so a crash ships the whole batch again and the append skips every
 * `event_id` the log already has.
 */
export async function shipAuditBatch(
  db: DrizzleDb,
  { wait = false }: { wait?: boolean } = {},
): Promise<number | null> {
  const result = await db.transaction(async (tx) => {
    const { rows } = await tx.execute<{ locked: boolean }>(
      wait
        ? sql`SELECT true AS locked FROM pg_advisory_xact_lock(hashtext(${SHIPPER_LOCK_KEY}))`
        : sql`SELECT pg_try_advisory_xact_lock(hashtext(${SHIPPER_LOCK_KEY})) AS locked`,
    );
    if (!rows[0]?.locked) {
      return null;
    }
    const batch = await tx
      .select({ id: auditOutbox.id, eventId: auditOutbox.eventId, entry: auditOutbox.entry })
      .from(auditOutbox)
      .orderBy(asc(auditOutbox.id))
      .limit(BATCH_SIZE);
    const shippable: (ShippableEntry & { outboxId: number })[] = [];
    const rejected: Rejection[] = [];
    for (const row of batch) {
      const parsed = OutboxEntrySchema.safeParse(row.entry);
      if (parsed.success) {
        shippable.push({ outboxId: row.id, eventId: row.eventId, entry: parsed.data });
      } else {
        rejected.push({
          outboxId: row.id,
          eventId: row.eventId,
          error: z.prettifyError(parsed.error),
        });
      }
    }
    await appendAuditEntries(tx, shippable);
    // What the delete guard checks: a row whose event id is chained with other content, already
    // or just now, is moved aside rather than deleted as shipped.
    if (shippable.length > 0) {
      const unmatched = await tx
        .select({ outboxId: auditOutbox.id, eventId: auditOutbox.eventId })
        .from(auditOutbox)
        .where(
          and(
            inArray(
              auditOutbox.id,
              shippable.map(({ outboxId }) => outboxId),
            ),
            sql`NOT audit_outbox_entry_chained(${auditOutbox.eventId}, ${auditOutbox.entry})`,
          ),
        );
      rejected.push(...unmatched.map((row) => ({ ...row, error: CHAINED_WITH_OTHER_CONTENT })));
    }
    if (rejected.length > 0) {
      // Copied in SQL, so the entry the guard compares is the outbox's own jsonb, not a JS round
      // trip of it.
      await tx.execute(sql`
        INSERT INTO audit_outbox_rejected (outbox_id, event_id, entry, error, created_at)
        SELECT o.id, o.event_id, o.entry, r.error, o.created_at
          FROM audit_outbox o
          JOIN jsonb_to_recordset(${JSON.stringify(rejected)}::jsonb) AS r("outboxId" bigint, error text)
            ON r."outboxId" = o.id
        ON CONFLICT (outbox_id) DO NOTHING`);
    }
    if (batch.length > 0) {
      await tx.delete(auditOutbox).where(
        inArray(
          auditOutbox.id,
          batch.map(({ id }) => id),
        ),
      );
    }
    return { size: batch.length, rejected };
  });
  if (!result) {
    return null;
  }
  for (const { outboxId, eventId, error } of result.rejected) {
    log.error({ outboxId, eventId, error }, 'audit outbox row moved to audit_outbox_rejected');
  }
  return result.size;
}

/**
 * Ships everything queued in `db` before the call, waiting for a running shipper rather than
 * skipping. For tests and tools that read `audit_log` straight after a write.
 */
export async function drainAuditOutbox(db: DrizzleDb): Promise<void> {
  while ((await shipAuditBatch(db, { wait: true })) === BATCH_SIZE) {
    // A full batch may have left more behind.
  }
}

/**
 * How far the chain lags the writes: the rows waiting in `audit_outbox`, the age of the oldest by
 * the database clock (null when none wait), and the rows moved to `audit_outbox_rejected`. For an
 * operator's health probe or alert; a growing age means no shipper is shipping.
 */
export async function auditOutboxBacklog(db: DrizzleDb): Promise<{
  pending: number;
  oldestPendingAgeMs: number | null;
  rejected: number;
}> {
  const { rows } = await db.execute<{
    pending: number;
    oldest_pending_age_ms: number | null;
    rejected: number;
  }>(
    sql`SELECT count(*)::int AS pending,
               (extract(epoch FROM now() - min(created_at)) * 1000)::float8 AS oldest_pending_age_ms,
               (SELECT count(*)::int FROM audit_outbox_rejected) AS rejected
          FROM audit_outbox`,
  );
  const [row] = rows;
  return {
    pending: row?.pending ?? 0,
    oldestPendingAgeMs: row?.oldest_pending_age_ms ?? null,
    rejected: row?.rejected ?? 0,
  };
}

export type AuditShipperOptions = {
  /** Idle wait between polls, in ms. */
  intervalMs?: number;
  onError?: (err: unknown) => void;
};

/**
 * Ships `audit_outbox` to the chain in the background: polls every `intervalMs`, keeps going
 * while batches come back full, and backs off exponentially (capped at 5s) while shipping fails.
 * Every replica runs one; the shipper lock lets one ship at a time and the rest skip.
 *
 * ponytail: polls every 200ms per replica (an indexed, usually empty read). Swap for LISTEN/NOTIFY
 * if the idle load or the audit lag matters.
 */
export class AuditShipper {
  private running = false;
  // Bumped on every start and stop, so a drain left over from an earlier run never schedules a
  // second loop beside the current one.
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private draining: Promise<void> | undefined;
  private failures = 0;

  constructor(
    private readonly db: DrizzleDb,
    private readonly opts: AuditShipperOptions = {},
  ) {}

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.generation += 1;
    this.schedule(this.generation);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.generation += 1;
    clearTimeout(this.timer);
    await this.draining;
  }

  private schedule(generation: number): void {
    const intervalMs = this.opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    const delayMs =
      this.failures === 0 ? intervalMs : Math.min(intervalMs * 2 ** this.failures, MAX_BACKOFF_MS);
    this.timer = setTimeout(() => {
      const draining = this.drain(generation).finally(() => {
        if (this.draining === draining) {
          this.draining = undefined;
        }
      });
      this.draining = draining;
    }, delayMs);
    this.timer.unref?.();
  }

  private async drain(generation: number): Promise<void> {
    const current = () => generation === this.generation;
    try {
      while (current() && (await shipAuditBatch(this.db)) === BATCH_SIZE) {
        // Keep going while batches come back full, so a backlog clears at append speed.
      }
      this.failures = 0;
    } catch (err) {
      this.failures += 1;
      this.opts.onError?.(err);
    }
    if (current()) {
      this.schedule(generation);
    }
  }
}

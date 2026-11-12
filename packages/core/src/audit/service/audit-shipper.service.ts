import { auditOutbox, type DrizzleDb } from '@openora/core/server';
import { asc, inArray, sql } from 'drizzle-orm';
import { appendAuditEntries } from './audit.service.js';

const BATCH_SIZE = 1_000;
const SHIPPER_LOCK_KEY = 'audit_shipper';

/**
 * Moves one batch of `audit_outbox` rows from `source` into the hash chain on `target`, oldest
 * first. Holds the shipper lock in a `source` transaction for the whole batch, so one shipper per
 * source database ships at a time; returns null when another holds it and `wait` is false. On a
 * separate `target` the rows are deleted only after its append commits: a crash between the two
 * commits ships them again, and the append skips every `event_id` the log already has.
 */
export function shipAuditBatch(
  source: DrizzleDb,
  target: DrizzleDb,
  { wait = false }: { wait?: boolean } = {},
): Promise<number | null> {
  return source.transaction(async (tx) => {
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
    if (batch.length === 0) {
      return 0;
    }
    // On one database the append and the delete share the transaction (and its one connection).
    await (source === target
      ? appendAuditEntries(tx, batch)
      : target.transaction((targetTx) => appendAuditEntries(targetTx, batch)));
    await tx.delete(auditOutbox).where(
      inArray(
        auditOutbox.id,
        batch.map(({ id }) => id),
      ),
    );
    return batch.length;
  });
}

/**
 * Ships everything queued in `db` before the call, waiting for a running shipper rather than
 * skipping. For tests and tools that read `audit_log` straight after a write.
 */
export async function drainAuditOutbox(db: DrizzleDb, target: DrizzleDb = db): Promise<void> {
  while ((await shipAuditBatch(db, target, { wait: true })) === BATCH_SIZE) {
    // A full batch may have left more behind.
  }
}

/**
 * Ships `audit_outbox` to the chain in the background, every `intervalMs` and until a batch comes
 * back short. Every replica runs one; the shipper lock lets one ship per tick and the rest skip.
 *
 * ponytail: polls every 200ms per replica (an indexed, usually empty read). Swap for LISTEN/NOTIFY
 * if the idle load or the audit lag matters.
 */
export class AuditShipper {
  private timer: ReturnType<typeof setInterval> | undefined;
  private draining: Promise<void> | undefined;

  constructor(
    private readonly source: DrizzleDb,
    private readonly target: DrizzleDb,
    private readonly opts: { intervalMs?: number; onError?: (err: unknown) => void } = {},
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      this.draining ??= this.drain().finally(() => {
        this.draining = undefined;
      });
    }, this.opts.intervalMs ?? 200);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.draining;
  }

  private async drain(): Promise<void> {
    try {
      while (this.timer && (await shipAuditBatch(this.source, this.target)) === BATCH_SIZE) {
        // Keep going while batches come back full, so a backlog clears at append speed.
      }
    } catch (err) {
      this.opts.onError?.(err);
    }
  }
}

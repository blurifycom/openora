import * as z from 'zod';
import { auditOutbox, createLogger, type DrizzleDb, type DrizzleTx } from '@openora/core/server';
import { asc, inArray, sql } from 'drizzle-orm';
import { appendAuditEntries, OutboxEntrySchema, type ShippableEntry } from './audit.service.js';
import { CHAIN_SPLIT_SQL } from '../schema/index.js';

const BATCH_SIZE = 1_000;
const SHIPPER_LOCK_KEY = 'audit_shipper';
const DEFAULT_INTERVAL_MS = 200;
const MAX_BACKOFF_MS = 5_000;

const log = createLogger('audit-shipper');

type Rejection = { outboxId: number; eventId: string; error: string };

const CHAINED_WITH_OTHER_CONTENT = 'event_id already chained with different content';

type Shippable = ShippableEntry & { outboxId: number; raw: string };

/**
 * Appends `shippable` to the chain `txn` reaches and returns the rows the chain holds with other
 * content. Each entry is compared as the outbox's own jsonb text, never a JS round trip of it.
 */
async function chain(txn: DrizzleTx, shippable: Shippable[]): Promise<Rejection[]> {
  await appendAuditEntries(txn, shippable);
  if (shippable.length === 0) {
    return [];
  }
  const rows = shippable.map(({ outboxId, eventId, raw }) => ({ outboxId, eventId, entry: raw }));
  const { rows: unmatched } = await txn.execute<{ outboxId: string; eventId: string }>(sql`
    SELECT r."outboxId", r."eventId"
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS r("outboxId" bigint, "eventId" uuid, entry text)
     WHERE NOT audit_outbox_entry_chained(r."eventId", r.entry::jsonb)`);
  return unmatched.map(({ outboxId, eventId }) => ({
    outboxId: Number(outboxId),
    eventId,
    error: CHAINED_WITH_OTHER_CONTENT,
  }));
}

// True once split migrate has moved this database's chain out, so shipping into it would build a
// second chain the readers never see.
async function chainMovedOut(tx: DrizzleTx): Promise<boolean> {
  const { rows } = await tx.execute<{ split: boolean }>(sql.raw(CHAIN_SPLIT_SQL));
  return rows[0]?.split ?? false;
}

// A chain started empty while the main database still holds the old one would fork the history:
// the old rows are copied over first (the audit-copy runbook), and only then may the shipper append.
async function refuseChainBeforeCopy(main: DrizzleTx, chainTx: DrizzleTx): Promise<void> {
  const { rows: chain } = await chainTx.execute<{ empty: boolean }>(
    sql`SELECT NOT EXISTS (SELECT 1 FROM audit_log) AS empty`,
  );
  if (!chain[0]?.empty) {
    return;
  }
  const { rows: legacy } = await main.execute<{ present: boolean }>(
    sql`SELECT to_regclass('public.audit_log') IS NOT NULL AS present`,
  );
  if (!legacy[0]?.present) {
    return;
  }
  const { rows: held } = await main.execute<{ held: boolean }>(
    sql`SELECT EXISTS (SELECT 1 FROM audit_log) AS held`,
  );
  if (held[0]?.held) {
    throw new Error(
      'the audit database is empty while the main database still holds audit_log rows: copy the chain over before shipping',
    );
  }
}

/**
 * Moves one batch of `audit_outbox` rows from `db` into the hash chain in `chainDb` (default `db`,
 * the single-database layout), oldest first, in one transaction on `db` that holds the
 * shipper lock, so one shipper per database ships at a time; returns null when another holds it
 * and `wait` is false. A row the chain cannot take as it is moves to `audit_outbox_rejected`,
 * copied unchanged with the reason, and the rest ship: an entry that fails its schema, or one
 * whose event id the chain already holds with other content (a forged or colliding row), which is
 * never dropped as a duplicate. The rows are deleted once the append has committed, in the same
 * transaction when the chain shares the database and right after its own otherwise, so a crash
 * ships the whole batch again and the append skips every `event_id` the log already has.
 *
 * With the chain in its own database, `db` must reach the main one as the shipper role
 * (`AUDIT_SHIPPER_DRIZZLE`), the only role its outbox guard lets delete. Nothing checks that
 * `chainDb` points at the chain's database; the split mark split `migrate` leaves on the main
 * database is the guard: with `chainDb` left as `db` there, this throws instead of shipping. It
 * also throws before the first append into an empty chain while the main database still holds the
 * old one.
 */
export async function shipAuditBatch(
  db: DrizzleDb,
  { wait = false, chainDb = db }: { wait?: boolean; chainDb?: DrizzleDb } = {},
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
      .select({
        id: auditOutbox.id,
        eventId: auditOutbox.eventId,
        entry: auditOutbox.entry,
        raw: sql<string>`${auditOutbox.entry}::text`,
      })
      .from(auditOutbox)
      .orderBy(asc(auditOutbox.id))
      .limit(BATCH_SIZE);
    const shippable: Shippable[] = [];
    const rejected: Rejection[] = [];
    for (const row of batch) {
      const parsed = OutboxEntrySchema.safeParse(row.entry);
      if (parsed.success) {
        shippable.push({
          outboxId: row.id,
          eventId: row.eventId,
          entry: parsed.data,
          raw: row.raw,
        });
      } else {
        rejected.push({
          outboxId: row.id,
          eventId: row.eventId,
          error: z.prettifyError(parsed.error),
        });
      }
    }
    // What the delete guard checks: a row whose event id is chained with other content, already
    // or just now, is moved aside rather than deleted as shipped.
    if (chainDb === db) {
      if (batch.length > 0 && (await chainMovedOut(tx))) {
        throw new Error(
          'the audit chain of this database lives in a database of its own: ship with its chainDb (AUDIT_DRIZZLE) as the shipper role (AUDIT_SHIPPER_DRIZZLE)',
        );
      }
      rejected.push(...(await chain(tx, shippable)));
    } else {
      rejected.push(
        ...(await chainDb.transaction(async (chainTx) => {
          if (shippable.length > 0) {
            await refuseChainBeforeCopy(tx, chainTx);
          }
          return chain(chainTx, shippable);
        })),
      );
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
 * Ships everything queued in `db` before the call into the chain in `chainDb`, waiting for a
 * running shipper rather than skipping. For tests and tools that read `audit_log` straight after a
 * write.
 */
export async function drainAuditOutbox(db: DrizzleDb, chainDb: DrizzleDb = db): Promise<void> {
  while ((await shipAuditBatch(db, { wait: true, chainDb })) === BATCH_SIZE) {
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
  /** The database holding the chain; defaults to the one holding the outbox. */
  chainDb?: DrizzleDb;
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
      while (
        current() &&
        (await shipAuditBatch(this.db, { chainDb: this.opts.chainDb ?? this.db })) === BATCH_SIZE
      ) {
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

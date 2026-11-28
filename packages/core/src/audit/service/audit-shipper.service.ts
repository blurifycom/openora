import * as z from 'zod';
import { auditOutbox, createLogger, type DrizzleDb, type DrizzleTx } from '@openora/core/server';
import { asc, inArray, sql } from 'drizzle-orm';
import {
  appendAuditEntries,
  chainMovedOut,
  OutboxEntrySchema,
  type ShippableEntry,
} from './audit.service.js';
import { CHAIN_MOVED_TRIGGER } from '../schema/index.js';
import { INSTANCE_SQL } from './audit-split.service.js';

const BATCH_SIZE = 1_000;
const SHIPPER_LOCK_KEY = 'audit_shipper';
const DEFAULT_INTERVAL_MS = 200;
const MAX_BACKOFF_MS = 5_000;

const log = createLogger('audit-shipper');

type Rejection = { outboxId: number; eventId: string; error: string };

const CHAINED_WITH_OTHER_CONTENT = 'event_id already chained with different content';

type Shippable = ShippableEntry & { outboxId: number; raw: string };

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

async function instanceOf(tx: DrizzleTx): Promise<string | undefined> {
  const { rows } = await tx.execute<{ instance: string }>(sql.raw(INSTANCE_SQL));
  return rows[0]?.instance;
}

async function refuseChainBeforeCopy(main: DrizzleTx, chainTx: DrizzleTx): Promise<void> {
  const { rows: legacy } = await main.execute<{ present: boolean; fenced: boolean }>(
    sql`SELECT to_regclass('public.audit_log') IS NOT NULL AS present,
               EXISTS (SELECT 1 FROM pg_trigger
                        WHERE tgrelid = to_regclass('public.audit_log')
                          AND tgname = ${CHAIN_MOVED_TRIGGER} AND tgenabled = 'A') AS fenced`,
  );
  if (!legacy[0]?.present || (await instanceOf(main)) === (await instanceOf(chainTx))) {
    return;
  }
  const { rows: tail } = await main.execute<{ seq: string; hash: string }>(
    sql`SELECT seq::text AS seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1`,
  );
  if (!tail[0]) {
    return;
  }
  const { rows: copied } = await chainTx.execute<{ copied: boolean }>(
    sql`SELECT EXISTS (SELECT 1 FROM audit_log WHERE seq = ${tail[0].seq} AND hash = ${tail[0].hash}) AS copied`,
  );
  if (!copied[0]?.copied) {
    throw new Error(
      `the audit database lacks the main database's audit_log up to seq ${tail[0].seq}: copy the chain over before shipping`,
    );
  }
  if (!legacy[0].fenced) {
    throw new Error(
      'the main database audit_log is not fenced: copy the chain over before shipping (openora-audit-copy --fence --apply)',
    );
  }
}

async function shipAuditBatch(
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

export async function drainAuditOutbox(db: DrizzleDb, chainDb: DrizzleDb = db): Promise<void> {
  let shipped: number | null;
  do {
    shipped = await shipAuditBatch(db, { wait: true, chainDb });
  } while (shipped === BATCH_SIZE);
}

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
  chainDb?: DrizzleDb;
  intervalMs?: number;
  onError?: (err: unknown) => void;
};

export class AuditShipper {
  private running = false;
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
      while (current()) {
        const shipped = await shipAuditBatch(this.db, { chainDb: this.opts.chainDb ?? this.db });
        if (shipped !== BATCH_SIZE) {
          break;
        }
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

import { createHash, randomUUID } from 'node:crypto';
import * as z from 'zod';
import {
  auditOutbox,
  DrizzleService,
  getCurrentCorrelationId,
  likePrefix,
  noteAuditWrite,
  pageToOffset,
  serializeRow,
  withAdvisoryXactLock,
  type DrizzleTx,
  type EventBus,
  type SerializedRow,
} from '@openora/core/server';
import { eq, and, or, gt, gte, lte, like, asc, desc, sql, inArray } from 'drizzle-orm';
import {
  LimitChangeKindSchema,
  LimitPeriodSchema,
  LimitTypeSchema,
  MoneyAmountSchema,
  type AuditWritePort,
  type IdentityReader,
  type User,
} from '@openora/core/contracts';
import { auditLog, type AuditLog } from '../schema/index.js';
import {
  AuditActorTypeSchema,
  type AuditListFilters,
  type AuditExportFilters,
  type MyRgHistoryEntry,
  type MyRgHistoryFilters,
} from '../contract/index.js';

const RG_LIMIT_ACTION_PREFIX = 'rg.limit.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pick<T>(
  schema: { safeParse: (v: unknown) => { success: boolean; data?: T } },
  value: unknown,
): T | null {
  const result = schema.safeParse(value);
  return result.success ? (result.data ?? null) : null;
}

function toMyRgHistoryEntry(row: SerializedRow<AuditLog, 'createdAt'>): MyRgHistoryEntry {
  const after = isRecord(row.after) ? row.after : {};
  const isSet = row.action === 'rg.limit.set';
  const newAmountRaw = isSet ? after['amount'] : after['requestedAmount'];
  const newMinutesRaw = isSet ? after['minutes'] : after['requestedMinutes'];

  return {
    id: row.id,
    action: row.action,
    actorType: row.actorType,
    createdAt: row.createdAt,
    type: pick(LimitTypeSchema, after['type']),
    period: pick(LimitPeriodSchema, after['period']),
    kind: pick(LimitChangeKindSchema, after['kind']),
    previousAmount: pick(MoneyAmountSchema, after['previousAmount']),
    newAmount: pick(MoneyAmountSchema, newAmountRaw),
    previousMinutes: typeof after['previousMinutes'] === 'number' ? after['previousMinutes'] : null,
    newMinutes: typeof newMinutesRaw === 'number' ? newMinutesRaw : null,
    effectiveAt: typeof after['effectiveAt'] === 'string' ? after['effectiveAt'] : null,
    expiresAt: typeof after['expiresAt'] === 'string' ? after['expiresAt'] : null,
  };
}

const AUDIT_SORT_COLS = {
  createdAt: auditLog.createdAt,
  action: auditLog.action,
  actorId: auditLog.actorId,
  actorType: auditLog.actorType,
  resourceType: auditLog.resourceType,
  resourceId: auditLog.resourceId,
} as const;

// Key order is deterministic - changes here BREAK the chain for existing rows.
// Treat this as an append-only list. before/after/result are IN the chain - a row's
// mutation payload and outcome must be tamper-evident, not just its who/what/where.
type CanonicalHashInput = Pick<
  AuditLog,
  | 'id'
  | 'actorId'
  | 'actorType'
  | 'action'
  | 'resourceType'
  | 'resourceId'
  | 'before'
  | 'after'
  | 'result'
  | 'seq'
  | 'prevHash'
> & { createdAt: string };

// Postgres jsonb reorders object keys (length-then-lex) on read-back, so before/after
// must have their nested key order canonicalized before hashing - otherwise record()
// and verifyChain() disagree on the exact same data. Arrays keep their original order.
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, sortKeysDeep((value as Record<string, unknown>)[key])]),
  );
}

function canonicalHashInput(fields: CanonicalHashInput): string {
  return JSON.stringify({
    id: fields.id,
    actorId: fields.actorId,
    actorType: fields.actorType,
    action: fields.action,
    resourceType: fields.resourceType,
    resourceId: fields.resourceId,
    before: sortKeysDeep(fields.before ?? null),
    after: sortKeysDeep(fields.after ?? null),
    result: fields.result ?? null,
    seq: fields.seq,
    createdAt: fields.createdAt,
    prevHash: fields.prevHash ?? '',
  });
}

export function computeHash(fields: CanonicalHashInput): string {
  return createHash('sha256').update(canonicalHashInput(fields)).digest('hex');
}

export function startOfDayUtc(dateStr: string): Date {
  const d = new Date(dateStr);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

export function endOfDayUtc(dateStr: string): Date {
  const d = new Date(dateStr);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
}

function buildWhere(filters: AuditExportFilters) {
  const {
    actorId,
    actorType,
    action,
    actionPrefix,
    resourceType,
    resourceId,
    q,
    fromDate,
    toDate,
  } = filters;

  const searchTerms = q?.split(/\s+/).filter(Boolean) ?? [];

  return and(
    actorId ? eq(auditLog.actorId, actorId) : undefined,
    actorType ? eq(auditLog.actorType, actorType as AuditLog['actorType']) : undefined,
    action ? eq(auditLog.action, action) : undefined,
    actionPrefix ? like(auditLog.action, likePrefix(actionPrefix)) : undefined,
    resourceType ? eq(auditLog.resourceType, resourceType) : undefined,
    resourceId ? eq(auditLog.resourceId, resourceId) : undefined,
    searchTerms.length > 0
      ? or(
          inArray(auditLog.actorId, searchTerms),
          inArray(auditLog.resourceId, searchTerms),
          inArray(sql`${auditLog.after}->>'userId'`, searchTerms),
        )
      : undefined,
    fromDate ? gte(auditLog.createdAt, startOfDayUtc(fromDate)) : undefined,
    toDate ? lte(auditLog.createdAt, endOfDayUtc(toDate)) : undefined,
  );
}

const toDto = (row: AuditLog) => serializeRow(row, { dateFields: ['createdAt'] });

export type RecordInput = Parameters<AuditWritePort['record']>[0] & {
  result?: string | null;
};

// What `audit_outbox.entry` holds: the entry with the time it was written and its correlation id
// resolved at enqueue, inside the request that wrote it, so the shipper hashes when the change
// committed, not when it shipped. Checked at enqueue, so a bad entry fails the business
// transaction as an `audit_log` insert used to, instead of blocking the shipper behind it.
const OutboxEntrySchema = z.object({
  actorId: z.string().nullish(),
  actorType: AuditActorTypeSchema,
  action: z.string().min(1),
  resourceType: z.string().min(1),
  resourceId: z.string().nullish(),
  before: z.record(z.string(), z.unknown()).nullish(),
  after: z.record(z.string(), z.unknown()).nullish(),
  ip: z.string().nullish(),
  userAgent: z.string().nullish(),
  correlationId: z.string().nullable(),
  result: z.string().nullish(),
  createdAt: z.iso.datetime(),
});

type OutboxEntry = z.infer<typeof OutboxEntrySchema>;

/** One `audit_outbox` row on its way into the chain. */
export type ShippableEntry = { eventId: string; entry: unknown };

// Postgres takes at most 65,535 bind parameters per statement; at 17 columns a row, this many
// rows stay well under it.
const MAX_ROWS_PER_INSERT = 1_000;

function outboxEntry(input: RecordInput): OutboxEntry {
  // An entry that leaves the correlation id unset takes the one its context runs under, e.g. the
  // agent proposal an MCP execution writes for; an explicit value, null included, is kept.
  const correlationId =
    input.correlationId === undefined ? (getCurrentCorrelationId() ?? null) : input.correlationId;
  return OutboxEntrySchema.parse({ ...input, correlationId, createdAt: new Date().toISOString() });
}

async function enqueue(
  txn: DrizzleTx,
  rows: readonly { eventId: ShippableEntry['eventId']; entry: OutboxEntry }[],
) {
  for (let start = 0; start < rows.length; start += MAX_ROWS_PER_INSERT) {
    await txn
      .insert(auditOutbox)
      .values(rows.slice(start, start + MAX_ROWS_PER_INSERT))
      .onConflictDoNothing({ target: auditOutbox.eventId });
  }
}

/**
 * Queues one audit record inside the caller's transaction: it reaches `audit_log` once the
 * transaction commits and the audit shipper appends it to the hash chain, and never if it rolls
 * back. Takes no lock, so the business transaction never waits on the chain. `eventId` is the
 * record's identity: queueing the same one twice, before or after it ships, leaves one row.
 */
export async function enqueueAuditInTransaction(
  txn: DrizzleTx,
  input: RecordInput,
  eventId: ShippableEntry['eventId'] = randomUUID(),
): Promise<void> {
  await enqueue(txn, [{ eventId, entry: outboxEntry(input) }]);
  noteAuditWrite(input.actorId);
}

async function enqueueManyAuditInTransaction(
  txn: DrizzleTx,
  inputs: readonly RecordInput[],
): Promise<void> {
  await enqueue(
    txn,
    inputs.map((input) => ({ eventId: randomUUID(), entry: outboxEntry(input) })),
  );
  for (const { actorId } of inputs) {
    noteAuditWrite(actorId);
  }
}

function latestChainHash(txn: DrizzleTx) {
  return txn
    .select({ hash: auditLog.hash })
    .from(auditLog)
    .orderBy(desc(auditLog.seq))
    .limit(1)
    .then(([latest]) => latest?.hash ?? null);
}

/** The row `entry` appends at `seq` after `prevHash`, hashed over what is persisted. */
function chainedRow(
  { eventId, entry }: { eventId: ShippableEntry['eventId']; entry: OutboxEntry },
  { seq, prevHash }: { seq: number; prevHash: string | null },
) {
  const id = randomUUID();
  const createdAt = new Date(entry.createdAt);
  const hash = computeHash({
    id,
    actorId: entry.actorId ?? null,
    actorType: entry.actorType,
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
    result: entry.result ?? null,
    seq,
    createdAt: createdAt.toISOString(),
    prevHash,
  });
  return { ...entry, eventId, id, seq, prevHash, createdAt, hash };
}

/**
 * Appends `entries` to the hash chain in order, inside `txn` and under the chain lock, with one
 * read of the chain head and one sequence reservation for the lot. An entry whose `eventId` is
 * already in the log is skipped, so a batch shipped again after a crash adds nothing; the unique
 * `event_id`, `seq` and `prev_hash` indexes refuse what slips past the lock. Every entry is
 * checked again before any row is written, so a malformed one fails the whole batch.
 */
export async function appendAuditEntries(
  txn: DrizzleTx,
  entries: readonly ShippableEntry[],
): Promise<AuditLog[]> {
  const parsed = entries.map(({ eventId, entry }) => ({
    eventId,
    entry: OutboxEntrySchema.parse(entry),
  }));
  if (parsed.length === 0) {
    return [];
  }
  return withAdvisoryXactLock(txn, 'audit_log', async () => {
    const shipped = new Set(
      (
        await txn
          .select({ eventId: auditLog.eventId })
          .from(auditLog)
          .where(
            inArray(
              auditLog.eventId,
              parsed.map(({ eventId }) => eventId),
            ),
          )
      ).map(({ eventId }) => eventId),
    );
    const fresh = parsed.filter(({ eventId }) => !shipped.has(eventId));
    if (fresh.length === 0) {
      return [];
    }
    const headHash = await latestChainHash(txn);
    const { rows: reserved } = await txn.execute<{ seq: string | number }>(
      sql`SELECT nextval(pg_get_serial_sequence('audit_log', 'seq')) AS seq
          FROM generate_series(1, ${fresh.length}) ORDER BY seq`,
    );
    const rows: ReturnType<typeof chainedRow>[] = [];
    for (const [index, item] of fresh.entries()) {
      const seq = reserved[index]?.seq;
      if (seq === undefined) {
        throw new Error('audit_log: fewer sequence values were reserved than rows to append');
      }
      rows.push(chainedRow(item, { seq: Number(seq), prevHash: rows.at(-1)?.hash ?? headHash }));
    }
    const inserted: AuditLog[] = [];
    for (let start = 0; start < rows.length; start += MAX_ROWS_PER_INSERT) {
      inserted.push(
        ...(await txn
          .insert(auditLog)
          .values(rows.slice(start, start + MAX_ROWS_PER_INSERT))
          .returning()),
      );
    }
    return inserted;
  });
}

/**
 * Appends one row to the hash chain straight away, inside the caller's transaction and holding
 * the chain lock until it commits. For a deploy step that runs outside the container and reads
 * its own row back; everything else queues with `enqueueAuditInTransaction`, which takes no lock.
 * Kept for one release while those steps move off it.
 */
export async function recordAuditInTransaction(
  txn: DrizzleTx,
  input: RecordInput,
): Promise<AuditLog> {
  const [row] = await appendAuditEntries(txn, [
    { eventId: randomUUID(), entry: outboxEntry(input) },
  ]);
  if (!row) {
    throw new Error('audit_log: the record was not appended');
  }
  noteAuditWrite(input.actorId);
  return row;
}

export class AuditService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
    private readonly identityReader: IdentityReader,
  ) {}

  /** Queues `input` in a transaction of its own; `eventId` makes a redelivered event a no-op. */
  async record(input: RecordInput, eventId?: ShippableEntry['eventId']): Promise<void> {
    await this.drizzle.db.transaction((tx) => enqueueAuditInTransaction(tx, input, eventId));
  }

  recordInTransaction(tx: unknown, input: RecordInput): Promise<void> {
    return enqueueAuditInTransaction(tx as DrizzleTx, input);
  }

  recordManyInTransaction(tx: unknown, inputs: readonly RecordInput[]): Promise<void> {
    return enqueueManyAuditInTransaction(tx as DrizzleTx, inputs);
  }

  async list(filters: AuditListFilters) {
    const db = this.drizzle.db;
    const { page, limit } = filters;
    const offset = pageToOffset(page, limit);

    const where = buildWhere(filters);
    const sortBy = filters.sortBy ?? 'createdAt';
    const dir = (filters.sortOrder ?? 'desc') === 'asc' ? asc : desc;

    const [rows, countResult] = await Promise.all([
      db
        .select()
        .from(auditLog)
        .where(where)
        .orderBy(dir(AUDIT_SORT_COLS[sortBy]), dir(auditLog.seq))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(auditLog)
        .where(where),
    ]);

    return {
      items: rows.map(toDto),
      total: countResult[0]?.count ?? 0,
      page,
      limit,
    };
  }

  /** Player self-service RG limit history. Returns an empty page, not an error,
   * when the caller has no player profile. */
  async listMyRgHistory(userId: User['id'], filters: MyRgHistoryFilters) {
    const { page, limit } = filters;
    const playerId = await this.identityReader.getPlayerIdByUserId(userId);
    if (!playerId) {
      return { items: [], total: 0, page, limit };
    }

    const { items, total } = await this.list({
      page,
      limit,
      resourceType: 'player',
      resourceId: playerId,
      actionPrefix: RG_LIMIT_ACTION_PREFIX,
      sortOrder: filters.sortOrder,
    });

    return { items: items.map(toMyRgHistoryEntry), total, page, limit };
  }

  // Hard cap to prevent unbounded bulk extraction / OOM; exports exceeding it are
  // truncated to the latest rows. Use verifyChain for full-chain integrity.
  static readonly EXPORT_MAX_ROWS = 50_000;

  static readonly VERIFY_CHUNK_SIZE = 1_000;

  async exportCsv(filters: AuditExportFilters) {
    const db = this.drizzle.db;
    const where = buildWhere(filters);

    const sortBy = filters.sortBy ?? 'createdAt';
    const dir = (filters.sortOrder ?? 'desc') === 'asc' ? asc : desc;

    const rows = await db
      .select()
      .from(auditLog)
      .where(where)
      .orderBy(dir(AUDIT_SORT_COLS[sortBy]), dir(auditLog.seq))
      .limit(AuditService.EXPORT_MAX_ROWS);

    const header =
      'id,actorId,actorType,action,resourceType,resourceId,ip,correlationId,result,seq,prevHash,hash,createdAt';
    const lines = rows.map((r) =>
      [
        r.id,
        r.actorId ?? '',
        r.actorType,
        r.action,
        r.resourceType,
        r.resourceId ?? '',
        r.ip ?? '',
        r.correlationId ?? '',
        r.result ?? '',
        r.seq,
        r.prevHash ?? '',
        r.hash,
        r.createdAt.toISOString(),
      ]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(','),
    );

    return [header, ...lines].join('\n');
  }

  async verifyChain(): Promise<
    { valid: true } | { valid: false; firstBrokenSeq: number; rowId: string }
  > {
    let expectedPrevHash: string | null = null;
    let cursor: number | null = null;
    let hasMore = true;

    // Keyset-paged so a large chain verifies in constant memory; VERIFY_CHUNK_SIZE
    // caps how many rows are held per round-trip.
    while (hasMore) {
      const rows = await this.drizzle.db
        .select()
        .from(auditLog)
        .where(cursor === null ? undefined : gt(auditLog.seq, cursor))
        .orderBy(auditLog.seq)
        .limit(AuditService.VERIFY_CHUNK_SIZE);

      for (const row of rows) {
        if (row.prevHash !== expectedPrevHash) {
          return { valid: false, firstBrokenSeq: row.seq, rowId: row.id };
        }

        const expected = computeHash({
          id: row.id,
          actorId: row.actorId ?? null,
          actorType: row.actorType,
          action: row.action,
          resourceType: row.resourceType,
          resourceId: row.resourceId ?? null,
          before: row.before ?? null,
          after: row.after ?? null,
          result: row.result ?? null,
          seq: row.seq,
          createdAt: row.createdAt.toISOString(),
          prevHash: row.prevHash ?? null,
        });

        if (row.hash !== expected) {
          return { valid: false, firstBrokenSeq: row.seq, rowId: row.id };
        }

        expectedPrevHash = row.hash;
        cursor = row.seq;
      }

      hasMore = rows.length === AuditService.VERIFY_CHUNK_SIZE;
    }

    return { valid: true };
  }
}

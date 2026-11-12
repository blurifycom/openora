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
  type EventEnvelope,
  type IdentityReader,
  type User,
} from '@openora/core/contracts';
import { auditLog, type AuditLog } from '../schema/index.js';
import {
  AuditActorTypeSchema,
  AuditSnapshotSchema,
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

// What `audit_outbox.entry` holds: the entry with its correlation id and `createdAt` resolved at
// enqueue, inside the request that wrote it. `createdAt` is queue time: when the business
// transaction wrote the record, not when it committed or shipped; for a record mapped from an
// event it is the event's own time, so the tap and the consumer queue the same entry for it. `seq` is assigned at ship time
// and is the authoritative order of the chain; `createdAt` is not monotonic in it. Checked at
// enqueue, so a bad entry fails the business transaction as an `audit_log` insert used to; the
// shipper checks each row again and moves one that fails aside instead of stopping behind it.
export const OutboxEntrySchema = z.object({
  actorId: z.string().nullish(),
  actorType: AuditActorTypeSchema,
  action: z.string().min(1),
  resourceType: z.string().min(1),
  resourceId: z.string().nullish(),
  before: AuditSnapshotSchema.optional(),
  after: AuditSnapshotSchema.optional(),
  ip: z.string().nullish(),
  userAgent: z.string().nullish(),
  correlationId: z.string().nullable(),
  result: z.string().nullish(),
  // Postgres has no year 0, so such an entry could never be chained: refused here, it moves aside.
  createdAt: z.iso.datetime().refine((at) => !at.startsWith('0000'), 'year 0 cannot be stored'),
});

type OutboxEntry = z.infer<typeof OutboxEntrySchema>;

/** One `audit_outbox` row on its way into the chain. */
export type ShippableEntry = { eventId: string; entry: unknown };

// Postgres takes at most 65,535 bind parameters per statement; at 17 columns a row, this many
// rows stay well under it.
const MAX_ROWS_PER_INSERT = 1_000;

// `occurredAt` is the audited event's time, passed only by the audit plugin's event paths; any
// other record is stamped now, and a time key on the record itself is dropped by the schema, so a
// caller of `AUDIT_WRITER` cannot backdate its entry.
function outboxEntry(input: RecordInput, occurredAt?: EventEnvelope['occurredAt']): OutboxEntry {
  // An entry that leaves the correlation id unset takes the one its context runs under, e.g. the
  // agent proposal an MCP execution writes for; an explicit value, null included, is kept.
  const correlationId =
    input.correlationId === undefined ? (getCurrentCorrelationId() ?? null) : input.correlationId;
  const createdAt = (occurredAt === undefined ? new Date() : new Date(occurredAt)).toISOString();
  return OutboxEntrySchema.parse({ ...input, correlationId, createdAt });
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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `eventId` as the uuid `event_id` column takes: a uuid as it is, anything else (an event id
 * from a broker that does not mint uuids) as the sha1-based uuid of its text, so a redelivery
 * maps to the same id and still dedups.
 */
export function auditEventId(eventId: EventEnvelope['eventId']): ShippableEntry['eventId'] {
  if (UUID_PATTERN.test(eventId)) {
    return eventId;
  }
  const hex = createHash('sha1').update(eventId).digest('hex');
  const variant = ((Number.parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
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
  eventId: EventEnvelope['eventId'] = randomUUID(),
  occurredAt?: EventEnvelope['occurredAt'],
): Promise<void> {
  await enqueue(txn, [{ eventId: auditEventId(eventId), entry: outboxEntry(input, occurredAt) }]);
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

// The column types audit_log's snapshots as records, which every reader indexes by key, but the
// jsonb stores an array snapshot (a role's permission list) as is, as it always has.
// ponytail: widen the column type once its readers narrow arrays themselves.
const snapshot = (value: OutboxEntry['before']) => (value ?? null) as AuditLog['before'];

/** The row `entry` appends at `seq` after `prevHash`, hashed over what is persisted. */
function chainedRow(
  { eventId, entry }: { eventId: ShippableEntry['eventId']; entry: OutboxEntry },
  { seq, prevHash }: { seq: number; prevHash: string | null },
) {
  const id = randomUUID();
  const createdAt = new Date(entry.createdAt);
  const before = snapshot(entry.before);
  const after = snapshot(entry.after);
  const hash = computeHash({
    id,
    actorId: entry.actorId ?? null,
    actorType: entry.actorType,
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId ?? null,
    before,
    after,
    result: entry.result ?? null,
    seq,
    createdAt: createdAt.toISOString(),
    prevHash,
  });
  return { ...entry, before, after, eventId, id, seq, prevHash, createdAt, hash };
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
 * the `audit_log` chain lock until it commits, so every other append waits on the caller's
 * transaction. For a deploy step that runs outside the container and reads its own row back.
 *
 * @deprecated Use `enqueueAuditInTransaction`, which queues the record and takes no lock. Removed
 * in the next minor release.
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
  async record(
    input: RecordInput,
    eventId?: EventEnvelope['eventId'],
    occurredAt?: EventEnvelope['occurredAt'],
  ): Promise<void> {
    await this.drizzle.db.transaction((tx) =>
      enqueueAuditInTransaction(tx, input, eventId, occurredAt),
    );
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

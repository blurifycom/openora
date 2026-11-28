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
  type DrizzleDb,
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
  type Uuid,
} from '@openora/core/contracts';
import { auditLog, CHAIN_SPLIT_SQL, type AuditLog } from '../schema/index.js';
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

type RgHistoryRow = Pick<
  SerializedRow<AuditLog, 'createdAt'>,
  'id' | 'action' | 'actorType' | 'createdAt'
> & {
  after: unknown;
};

function toMyRgHistoryEntry(row: RgHistoryRow): MyRgHistoryEntry {
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

export function sortKeysDeep(value: unknown): unknown {
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

function startOfDayUtc(dateStr: string): Date {
  const d = new Date(dateStr);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

function endOfDayUtc(dateStr: string): Date {
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

function chainPage(
  db: DrizzleDb | DrizzleTx,
  filters: AuditExportFilters,
  { offset, limit }: { offset: number; limit: number },
) {
  const dir = (filters.sortOrder ?? 'desc') === 'asc' ? asc : desc;
  return db
    .select()
    .from(auditLog)
    .where(buildWhere(filters))
    .orderBy(dir(AUDIT_SORT_COLS[filters.sortBy ?? 'createdAt']), dir(auditLog.seq))
    .limit(limit)
    .offset(offset);
}

async function chainCount(db: DrizzleDb | DrizzleTx, filters: AuditExportFilters) {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(auditLog)
    .where(buildWhere(filters));
  return row?.count ?? 0;
}

const toDto = (row: AuditLog) => serializeRow(row, { dateFields: ['createdAt'] });

export type RecordInput = Parameters<AuditWritePort['record']>[0] & {
  result?: string | null;
};

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
  createdAt: z.iso.datetime().refine((at) => !at.startsWith('0000'), 'year 0 cannot be stored'),
});

type OutboxEntry = z.infer<typeof OutboxEntrySchema>;

export type ShippableEntry = { eventId: string; entry: unknown };

const MAX_ROWS_PER_INSERT = 1_000;

function outboxEntry(input: RecordInput, occurredAt?: EventEnvelope['occurredAt']): OutboxEntry {
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

function auditEventId(eventId: EventEnvelope['eventId']): ShippableEntry['eventId'] {
  if (UUID_PATTERN.test(eventId)) {
    return eventId;
  }
  const hex = createHash('sha1').update(eventId).digest('hex');
  const variant = ((Number.parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function enqueueOne(
  txn: DrizzleTx,
  input: RecordInput,
  eventId: ShippableEntry['eventId'],
  occurredAt?: EventEnvelope['occurredAt'],
): Promise<void> {
  await enqueue(txn, [{ eventId, entry: outboxEntry(input, occurredAt) }]);
  noteAuditWrite(input.actorId);
}

export function enqueueAuditInTransaction(txn: DrizzleTx, input: RecordInput): Promise<void> {
  return enqueueOne(txn, input, randomUUID());
}

export function enqueueEventAuditInTransaction(
  txn: DrizzleTx,
  input: RecordInput,
  { eventId, occurredAt }: Pick<EventEnvelope, 'eventId' | 'occurredAt'>,
): Promise<void> {
  return enqueueOne(txn, input, auditEventId(eventId), occurredAt);
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

const snapshot = (value: OutboxEntry['before']) => (value ?? null) as AuditLog['before'];

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

export async function chainMovedOut(tx: DrizzleTx): Promise<boolean> {
  const { rows } = await tx.execute<{ split: boolean }>(sql.raw(CHAIN_SPLIT_SQL));
  return rows[0]?.split ?? false;
}

export async function recordAuditInTransaction(
  txn: DrizzleTx,
  input: RecordInput,
): Promise<AuditLog> {
  if (await chainMovedOut(txn)) {
    throw new Error(
      'the audit chain of this database lives in a database of its own: append in a transaction on the audit database (AUDIT_DATABASE_URL)',
    );
  }
  const [row] = await appendAuditEntries(txn, [
    { eventId: randomUUID(), entry: outboxEntry(input) },
  ]);
  if (!row) {
    throw new Error('audit_log: the record was not appended');
  }
  noteAuditWrite(input.actorId);
  return row;
}

const hashOf = (row: AuditLog) =>
  computeHash({
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

const VERIFY_CHUNK_SIZE = 1_000;

export type AuditChainAnchor = { fromSeq: AuditLog['seq']; fromHash: AuditLog['hash'] };

export type AuditChainVerdict =
  | { valid: true }
  | { valid: false; firstBrokenSeq: AuditLog['seq']; rowId: AuditLog['id'] | null };

export async function verifyAuditChain(
  db: DrizzleDb,
  anchor?: AuditChainAnchor,
): Promise<AuditChainVerdict> {
  let expectedPrevHash: string | null = null;
  let cursor: number | null = null;
  if (anchor) {
    const [row] = await db.select().from(auditLog).where(eq(auditLog.seq, anchor.fromSeq)).limit(1);
    if (!row || row.hash !== anchor.fromHash || row.hash !== hashOf(row)) {
      return { valid: false, firstBrokenSeq: anchor.fromSeq, rowId: row?.id ?? null };
    }
    expectedPrevHash = row.hash;
    cursor = row.seq;
  }
  for (;;) {
    const rows = await db
      .select()
      .from(auditLog)
      .where(cursor === null ? undefined : gt(auditLog.seq, cursor))
      .orderBy(auditLog.seq)
      .limit(VERIFY_CHUNK_SIZE);
    for (const row of rows) {
      if (row.prevHash !== expectedPrevHash || row.hash !== hashOf(row)) {
        return { valid: false, firstBrokenSeq: row.seq, rowId: row.id };
      }
      expectedPrevHash = row.hash;
      cursor = row.seq;
    }
    if (rows.length < VERIFY_CHUNK_SIZE) {
      return { valid: true };
    }
  }
}

export class AuditService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
    private readonly identityReader: IdentityReader,
    private readonly auditDrizzle: DrizzleService = drizzle,
  ) {}

  async record(input: RecordInput): Promise<void> {
    await this.drizzle.db.transaction((tx) => enqueueAuditInTransaction(tx, input));
  }

  recordInTransaction(tx: unknown, input: RecordInput): Promise<void> {
    return enqueueAuditInTransaction(tx as DrizzleTx, input);
  }

  recordManyInTransaction(tx: unknown, inputs: readonly RecordInput[]): Promise<void> {
    return enqueueManyAuditInTransaction(tx as DrizzleTx, inputs);
  }

  async list(filters: AuditListFilters) {
    const { page, limit } = filters;
    const [rows, total] = await Promise.all([
      chainPage(this.auditDrizzle.db, filters, { offset: pageToOffset(page, limit), limit }),
      chainCount(this.auditDrizzle.db, filters),
    ]);
    return { items: rows.map(toDto), total, page, limit };
  }

  async listMyRgHistory(userId: User['id'], filters: MyRgHistoryFilters) {
    const { page, limit } = filters;
    const playerId = await this.identityReader.getPlayerIdByUserId(userId);
    if (!playerId) {
      return { items: [], total: 0, page, limit };
    }
    const scope = {
      resourceType: 'player',
      resourceId: playerId,
      actionPrefix: RG_LIMIT_ACTION_PREFIX,
      sortOrder: filters.sortOrder,
    };
    const queued = await this.queuedRgHistory(playerId);
    const offset = pageToOffset(page, limit);
    const newestFirst = (filters.sortOrder ?? 'desc') === 'desc';
    return this.auditDrizzle.db.transaction(
      async (tx) => {
        const chainedIds = new Set(
          queued.length === 0
            ? []
            : (
                await tx
                  .select({ eventId: auditLog.eventId })
                  .from(auditLog)
                  .where(
                    inArray(
                      auditLog.eventId,
                      queued.map(({ eventId }) => eventId),
                    ),
                  )
              ).map(({ eventId }) => eventId),
        );
        const pending = queued
          .filter(({ eventId }) => !chainedIds.has(eventId))
          .map(({ row }) => row);
        const chained = await chainCount(tx, scope);
        const lead = newestFirst ? pending.reverse() : [];
        const tail = newestFirst ? [] : pending;
        const fromLead = lead.slice(offset, offset + limit);
        const room = limit - fromLead.length;
        const rows =
          room > 0
            ? (
                await chainPage(tx, scope, {
                  offset: Math.max(0, offset - lead.length),
                  limit: room,
                })
              ).map((row) => ({ ...toDto(row), id: row.eventId ?? row.id }))
            : [];
        const tailStart = Math.max(0, offset - lead.length - chained);
        const fromTail = tail.slice(tailStart, tailStart + room - rows.length);
        return {
          items: [...fromLead, ...rows, ...fromTail].map(toMyRgHistoryEntry),
          total: chained + pending.length,
          page,
          limit,
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  private async queuedRgHistory(playerId: Uuid) {
    const rows = await this.drizzle.db
      .select({ eventId: auditOutbox.eventId, entry: auditOutbox.entry })
      .from(auditOutbox)
      .where(
        and(
          sql`${auditOutbox.entry}->>'resourceType' = 'player'`,
          sql`${auditOutbox.entry}->>'resourceId' = ${playerId}`,
          sql`${auditOutbox.entry}->>'action' LIKE ${likePrefix(RG_LIMIT_ACTION_PREFIX)}`,
        ),
      )
      .orderBy(asc(auditOutbox.id));
    return rows.flatMap(({ eventId, entry }) => {
      const parsed = OutboxEntrySchema.safeParse(entry);
      if (!parsed.success) {
        return [];
      }
      const { action, actorType, after, createdAt } = parsed.data;
      const row: RgHistoryRow = { id: eventId, action, actorType, after, createdAt };
      return [{ eventId, row }];
    });
  }

  static readonly EXPORT_MAX_ROWS = 50_000;

  static readonly VERIFY_CHUNK_SIZE = VERIFY_CHUNK_SIZE;

  async exportCsv(filters: AuditExportFilters) {
    const rows = await chainPage(this.auditDrizzle.db, filters, {
      offset: 0,
      limit: AuditService.EXPORT_MAX_ROWS,
    });

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

  verifyChain(anchor?: AuditChainAnchor): Promise<AuditChainVerdict> {
    return verifyAuditChain(this.auditDrizzle.db, anchor);
  }
}

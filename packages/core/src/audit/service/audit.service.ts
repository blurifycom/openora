import { createHash, randomUUID } from 'node:crypto';
import {
  DrizzleService,
  pageToOffset,
  serializeRow,
  withAdvisoryXactLock,
  type EventBus,
} from '@openora/core/server';
import { eq, and, or, gt, gte, lte, like, desc, sql } from 'drizzle-orm';
import type { AuditWritePort } from '@openora/core/contracts';
import { auditLog, type AuditLog } from '../schema/index.js';
import type { AuditListFilters, AuditExportFilters } from '../contract/index.js';

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

// Escape LIKE wildcards so a caller-supplied prefix ('rg.') matches literally and a
// stray % or _ can't widen the match. Backslash is the default PG escape char.
function likePrefix(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, '\\$&')}%`;
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

  return and(
    actorId ? eq(auditLog.actorId, actorId) : undefined,
    actorType ? eq(auditLog.actorType, actorType as AuditLog['actorType']) : undefined,
    action ? eq(auditLog.action, action) : undefined,
    actionPrefix ? like(auditLog.action, likePrefix(actionPrefix)) : undefined,
    resourceType ? eq(auditLog.resourceType, resourceType) : undefined,
    resourceId ? eq(auditLog.resourceId, resourceId) : undefined,
    q ? or(eq(auditLog.actorId, q), eq(auditLog.resourceId, q)) : undefined,
    fromDate ? gte(auditLog.createdAt, startOfDayUtc(fromDate)) : undefined,
    toDate ? lte(auditLog.createdAt, endOfDayUtc(toDate)) : undefined,
  );
}

const toDto = (row: AuditLog) => serializeRow(row, { dateFields: ['createdAt'] });

export type RecordInput = Parameters<AuditWritePort['record']>[0] & {
  result?: string | null;
};

export class AuditService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
  ) {}

  // Hash computed and inserted in a single statement - no read-back UPDATE, so a
  // crash can never leave a 'pending' hash. Serialized via pg advisory lock so
  // concurrent record() calls cannot fork the chain. Append-only.
  async record(input: RecordInput) {
    const row = await this.drizzle.db.transaction((tx) =>
      withAdvisoryXactLock(tx, 'audit_log', async () => {
        const [latest] = await tx
          .select({ hash: auditLog.hash })
          .from(auditLog)
          .orderBy(desc(auditLog.seq))
          .limit(1);
        const prevHash = latest?.hash ?? null;

        const seqResult = await tx.execute<{ seq: string | number }>(
          sql`SELECT nextval(pg_get_serial_sequence('audit_log', 'seq')) AS seq`,
        );
        const seq = +(seqResult.rows.at(0)?.seq ?? 0);

        const id = randomUUID();
        const createdAt = new Date();

        const hash = computeHash({
          id,
          actorId: input.actorId ?? null,
          actorType: input.actorType,
          action: input.action,
          resourceType: input.resourceType,
          resourceId: input.resourceId ?? null,
          before: input.before ?? null,
          after: input.after ?? null,
          result: input.result ?? null,
          seq,
          createdAt: createdAt.toISOString(),
          prevHash,
        });

        const [inserted] = await tx
          .insert(auditLog)
          .values({ ...input, id, seq, prevHash, createdAt, hash })
          .returning();

        return inserted;
      }),
    );

    return toDto(row);
  }

  async list(filters: AuditListFilters) {
    const db = this.drizzle.db;
    const { page, limit } = filters;
    const offset = pageToOffset(page, limit);

    const where = buildWhere(filters);

    const [rows, countResult] = await Promise.all([
      db
        .select()
        .from(auditLog)
        .where(where)
        .orderBy(desc(auditLog.seq))
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

  // Hard cap to prevent unbounded bulk extraction / OOM; exports exceeding it are
  // truncated to the latest rows. Use verifyChain for full-chain integrity.
  static readonly EXPORT_MAX_ROWS = 50_000;

  static readonly VERIFY_CHUNK_SIZE = 1_000;

  async exportCsv(filters: AuditExportFilters) {
    const db = this.drizzle.db;
    const where = buildWhere(filters);

    const rows = await db
      .select()
      .from(auditLog)
      .where(where)
      .orderBy(auditLog.seq)
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

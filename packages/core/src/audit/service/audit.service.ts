import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { DrizzleService, pageToOffset } from '@blurifycom/core/server';
import { type EventBus } from '@blurifycom/core/server';
import { eq, and, or, gte, lte, desc, sql } from 'drizzle-orm';
import { auditLog, type AuditLog } from '../schema/index.js';
import type { AuditLogEntry, AuditListFilters, AuditExportFilters } from '../schemas/index.js';

// Key order is deterministic - changes here BREAK the chain for existing rows.
// Treat this as an append-only list.
function canonicalHashInput(fields: {
  id: string;
  actorId: string | null;
  actorType: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  seq: number;
  createdAt: string;
  prevHash: string | null;
}): string {
  return JSON.stringify({
    id: fields.id,
    actorId: fields.actorId,
    actorType: fields.actorType,
    action: fields.action,
    resourceType: fields.resourceType,
    resourceId: fields.resourceId,
    seq: fields.seq,
    createdAt: fields.createdAt,
    prevHash: fields.prevHash ?? '',
  });
}

function computeHash(fields: Parameters<typeof canonicalHashInput>[0]): string {
  return createHash('sha256').update(canonicalHashInput(fields)).digest('hex');
}

function toDto(row: AuditLog): AuditLogEntry {
  return {
    id: row.id,
    actorId: row.actorId ?? null,
    actorType: row.actorType as AuditLogEntry['actorType'],
    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId ?? null,
    before: row.before ?? null,
    after: row.after ?? null,
    ip: row.ip ?? null,
    userAgent: row.userAgent ?? null,
    correlationId: row.correlationId ?? null,
    result: row.result ?? null,
    seq: row.seq,
    prevHash: row.prevHash ?? null,
    hash: row.hash,
    createdAt: row.createdAt.toISOString(),
  };
}

export type RecordInput = {
  actorId?: string | null;
  actorType: 'player' | 'admin' | 'system';
  action: string;
  resourceType: string;
  resourceId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
  correlationId?: string | null;
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
  async record(input: RecordInput): Promise<AuditLogEntry> {
    const row = await this.drizzle.db.transaction(async (tx) => {
      // pg_advisory_xact_lock serializes appends without locking the whole table.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('audit_log'))`);

      const [latest] = await tx
        .select({ hash: auditLog.hash })
        .from(auditLog)
        .orderBy(desc(auditLog.seq))
        .limit(1);
      const prevHash = latest?.hash ?? null;

      // Reserve the seq BEFORE insert so the hash covers the final seq value.
      const seqResult = await tx.execute<{ seq: string | number }>(
        sql`SELECT nextval(pg_get_serial_sequence('audit_log', 'seq')) AS seq`,
      );
      const seq = Number((seqResult.rows[0] as { seq: string | number }).seq);

      // Generated here (not DB-defaulted) so the hash input matches the persisted row.
      const id = randomUUID();
      const createdAt = new Date();

      const hash = computeHash({
        id,
        actorId: input.actorId ?? null,
        actorType: input.actorType,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId ?? null,
        seq,
        createdAt: createdAt.toISOString(),
        prevHash,
      });

      const [inserted] = await tx
        .insert(auditLog)
        .values({
          id,
          actorId: input.actorId ?? null,
          actorType: input.actorType,
          action: input.action,
          resourceType: input.resourceType,
          resourceId: input.resourceId ?? null,
          before: input.before ?? null,
          after: input.after ?? null,
          ip: input.ip ?? null,
          userAgent: input.userAgent ?? null,
          correlationId: input.correlationId ?? null,
          result: input.result ?? null,
          seq,
          prevHash,
          createdAt,
          hash,
        })
        .returning();

      return inserted!;
    });

    return toDto(row);
  }

  async list(filters: AuditListFilters): Promise<{
    items: AuditLogEntry[];
    total: number;
    page: number;
    limit: number;
  }> {
    const db = this.drizzle.db;
    const {
      actorId,
      actorType,
      action,
      resourceType,
      resourceId,
      q,
      fromDate,
      toDate,
      page,
      limit,
    } = filters;
    const offset = pageToOffset(page, limit);

    const conditions = [
      actorId !== undefined ? eq(auditLog.actorId, actorId) : undefined,
      actorType !== undefined
        ? eq(auditLog.actorType, actorType as AuditLog['actorType'])
        : undefined,
      action !== undefined ? eq(auditLog.action, action) : undefined,
      resourceType !== undefined ? eq(auditLog.resourceType, resourceType) : undefined,
      resourceId !== undefined ? eq(auditLog.resourceId, resourceId) : undefined,
      q !== undefined ? or(eq(auditLog.actorId, q), eq(auditLog.resourceId, q)) : undefined,
      fromDate !== undefined ? gte(auditLog.createdAt, new Date(fromDate)) : undefined,
      toDate !== undefined ? lte(auditLog.createdAt, new Date(toDate)) : undefined,
    ].filter((c): c is NonNullable<typeof c> => c !== undefined);

    const where = conditions.length > 0 ? and(...conditions) : undefined;

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

  async exportCsv(filters: AuditExportFilters): Promise<string> {
    const db = this.drizzle.db;
    const { actorId, actorType, action, resourceType, resourceId, q, fromDate, toDate } = filters;

    const conditions = [
      actorId !== undefined ? eq(auditLog.actorId, actorId) : undefined,
      actorType !== undefined
        ? eq(auditLog.actorType, actorType as AuditLog['actorType'])
        : undefined,
      action !== undefined ? eq(auditLog.action, action) : undefined,
      resourceType !== undefined ? eq(auditLog.resourceType, resourceType) : undefined,
      resourceId !== undefined ? eq(auditLog.resourceId, resourceId) : undefined,
      q !== undefined ? or(eq(auditLog.actorId, q), eq(auditLog.resourceId, q)) : undefined,
      fromDate !== undefined ? gte(auditLog.createdAt, new Date(fromDate)) : undefined,
      toDate !== undefined ? lte(auditLog.createdAt, new Date(toDate)) : undefined,
    ].filter((c): c is NonNullable<typeof c> => c !== undefined);

    const where = conditions.length > 0 ? and(...conditions) : undefined;

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
    const rows = await this.drizzle.db.select().from(auditLog).orderBy(auditLog.seq);

    let expectedPrevHash: string | null = null;

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
        seq: row.seq,
        createdAt: row.createdAt.toISOString(),
        prevHash: row.prevHash ?? null,
      });

      if (row.hash !== expected) {
        return { valid: false, firstBrokenSeq: row.seq, rowId: row.id };
      }

      expectedPrevHash = row.hash;
    }

    return { valid: true };
  }
}

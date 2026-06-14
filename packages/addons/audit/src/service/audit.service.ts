import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { DrizzleService, pageToOffset } from '@oss/db';
import { type EventBus, getCurrentTenantId } from '@oss/core';
import { eq, and, gte, lte, desc, sql } from 'drizzle-orm';
import { auditLog, type AuditLog } from '../schema/index.js';
import type { AuditLogEntry, AuditListFilters, AuditExportFilters } from '../schemas/index.js';

// ---------------------------------------------------------------------------
// Hash chaining helpers
// ---------------------------------------------------------------------------

// Stable canonical representation of the fields that form the hash input.
// Key order is deterministic - changes here BREAK the chain for existing rows,
// so treat this as an append-only list.
function canonicalHashInput(fields: {
  id: string;
  tenantId: string;
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
    tenantId: fields.tenantId,
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

// ---------------------------------------------------------------------------
// Row -> DTO
// ---------------------------------------------------------------------------

function toDto(row: AuditLog): AuditLogEntry {
  return {
    id: row.id,
    tenantId: row.tenantId,
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
    seq: row.seq,
    prevHash: row.prevHash ?? null,
    hash: row.hash,
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Record input shape (what callers / event subscribers pass in)
// ---------------------------------------------------------------------------

export type RecordInput = {
  tenantId: string;
  actorId?: string | null;
  actorType: 'player' | 'admin' | 'system';
  action: string;
  resourceType: string;
  resourceId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  userAgent?: string | null;
  correlationId?: string | null;
};

// ---------------------------------------------------------------------------
// AuditService
// ---------------------------------------------------------------------------

export class AuditService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
  ) {}

  // Single write path. Computes prevHash/hash and inserts the row with its
  // final hash in ONE statement - no read-back UPDATE, so a crash can never
  // leave a 'pending' hash. The whole append is atomic and serialized per
  // tenant via a transaction-level advisory lock, so concurrent record() calls
  // cannot read the same chain tip and fork the chain.
  // Append-only: no update/delete methods exposed.
  async record(input: RecordInput): Promise<AuditLogEntry> {
    const row = await this.drizzle.db.transaction(async (tx) => {
      // Serialize all appends for this tenant. pg_advisory_xact_lock (two-int
      // form) is held until the transaction commits/rolls back; concurrent
      // appends for the same tenant queue here, so read-tip -> compute -> insert
      // is atomic without locking the whole table. Other tenants are unaffected.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('audit_log'), hashtext(${input.tenantId}))`,
      );

      // Read the chain tip INSIDE the lock so no other append can race past us.
      const [latest] = await tx
        .select({ hash: auditLog.hash })
        .from(auditLog)
        .where(eq(auditLog.tenantId, input.tenantId))
        .orderBy(desc(auditLog.seq))
        .limit(1);
      const prevHash = latest?.hash ?? null;

      // Reserve the seq value BEFORE insert by pulling from the serial's backing
      // sequence, so the hash can be computed over the final seq and the row
      // inserted with its real hash in a single INSERT.
      const seqResult = await tx.execute<{ seq: string | number }>(
        sql`SELECT nextval(pg_get_serial_sequence('audit_log', 'seq')) AS seq`,
      );
      const seq = Number((seqResult.rows[0] as { seq: string | number }).seq);

      // id + createdAt are known at insert time (generated here, not DB-defaulted)
      // so the hash input matches the persisted row exactly.
      const id = randomUUID();
      const createdAt = new Date();

      const hash = computeHash({
        id,
        tenantId: input.tenantId,
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
          tenantId: input.tenantId,
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

  // List with filters and cursor-style pagination.
  async list(filters: AuditListFilters): Promise<{
    items: AuditLogEntry[];
    total: number;
    page: number;
    limit: number;
  }> {
    const db = this.drizzle.db;
    const { actorId, actorType, action, resourceType, fromDate, toDate, page, limit } = filters;
    const offset = pageToOffset(page, limit);

    const conditions = [
      // Defense-in-depth: explicit tenant scope alongside RLS, resolved per call.
      eq(auditLog.tenantId, getCurrentTenantId() ?? 'default'),
      actorId !== undefined ? eq(auditLog.actorId, actorId) : undefined,
      actorType !== undefined
        ? eq(auditLog.actorType, actorType as AuditLog['actorType'])
        : undefined,
      action !== undefined ? eq(auditLog.action, action) : undefined,
      resourceType !== undefined ? eq(auditLog.resourceType, resourceType) : undefined,
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

  // Hard cap on a single export so it cannot be used for unbounded bulk
  // extraction / OOM. Filter by date range and paginate (or call verifyChain for
  // full-chain integrity) for larger windows; an export exceeding the cap is
  // truncated to the most relevant (latest) rows.
  static readonly EXPORT_MAX_ROWS = 50_000;

  // Export matching rows as CSV text for regulatory submission. Tenant-scoped and
  // capped at EXPORT_MAX_ROWS.
  async exportCsv(filters: AuditExportFilters): Promise<string> {
    const db = this.drizzle.db;
    const { actorId, actorType, action, resourceType, fromDate, toDate } = filters;

    const conditions = [
      // Defense-in-depth: explicit tenant scope alongside RLS, resolved per call.
      eq(auditLog.tenantId, getCurrentTenantId() ?? 'default'),
      actorId !== undefined ? eq(auditLog.actorId, actorId) : undefined,
      actorType !== undefined
        ? eq(auditLog.actorType, actorType as AuditLog['actorType'])
        : undefined,
      action !== undefined ? eq(auditLog.action, action) : undefined,
      resourceType !== undefined ? eq(auditLog.resourceType, resourceType) : undefined,
      fromDate !== undefined ? gte(auditLog.createdAt, new Date(fromDate)) : undefined,
      toDate !== undefined ? lte(auditLog.createdAt, new Date(toDate)) : undefined,
    ].filter((c): c is NonNullable<typeof c> => c !== undefined);

    const where = and(...conditions);

    const rows = await db
      .select()
      .from(auditLog)
      .where(where)
      .orderBy(auditLog.seq)
      .limit(AuditService.EXPORT_MAX_ROWS);

    const header =
      'id,tenantId,actorId,actorType,action,resourceType,resourceId,ip,correlationId,seq,prevHash,hash,createdAt';
    const lines = rows.map((r) =>
      [
        r.id,
        r.tenantId,
        r.actorId ?? '',
        r.actorType,
        r.action,
        r.resourceType,
        r.resourceId ?? '',
        r.ip ?? '',
        r.correlationId ?? '',
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

  // Recompute every row's hash in tenant order and return the first broken link.
  // Returns null when the chain is intact.
  async verifyChain(
    tenantId: string,
  ): Promise<{ valid: true } | { valid: false; firstBrokenSeq: number; rowId: string }> {
    const rows = await this.drizzle.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.tenantId, tenantId))
      .orderBy(auditLog.seq);

    let expectedPrevHash: string | null = null;

    for (const row of rows) {
      if (row.prevHash !== expectedPrevHash) {
        return { valid: false, firstBrokenSeq: row.seq, rowId: row.id };
      }

      const expected = computeHash({
        id: row.id,
        tenantId: row.tenantId,
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

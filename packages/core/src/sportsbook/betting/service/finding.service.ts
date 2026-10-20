import { and, count, desc, eq, sql, type SQL } from 'drizzle-orm';
import {
  findOneOrThrow,
  makeConflictError,
  makeNotFoundError,
  pageToOffset,
  type AdminCaller,
  type DrizzleDb,
  type DrizzleService,
  type DrizzleTx,
} from '@openora/core/server';
import type { AuditWritePort } from '@openora/core/contracts';
import type {
  ListSportsbookFindingsInput,
  SportsbookFinding,
  SportsbookFindingKind,
} from '../contract/index.js';
import {
  sportsbookBet,
  sportsbookReconciliationFinding,
  type SportsbookFindingRow,
} from '../schema/index.js';

export const SportsbookFindingNotFoundError = makeNotFoundError('SportsbookFinding');
export const SportsbookFindingResolvedError = makeConflictError(
  'SportsbookFindingResolvedError',
  'This finding is already resolved',
  { reason: 'finding_resolved' },
);

export type SportsbookFindingArgs = {
  kind: SportsbookFindingKind;
  /** One open finding per key: filing it again while open is a no-op. */
  dedupeKey: string;
  provider?: string | null;
  betId?: SportsbookFindingRow['betId'];
  userId?: SportsbookFindingRow['userId'];
  detail?: Record<string, unknown>;
};

function toFinding(
  row: SportsbookFindingRow,
  currency: SportsbookFinding['currency'],
): SportsbookFinding {
  return {
    id: row.id,
    kind: row.kind,
    provider: row.provider,
    betId: row.betId,
    userId: row.userId,
    currency,
    detail: row.detail,
    status: row.status,
    resolvedBy: row.resolvedBy,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolutionNote: row.resolutionNote,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Inside a ledger transaction, file it before any audit write: audit_log is always the last lock. */
export async function fileFinding(
  db: DrizzleDb | DrizzleTx,
  { kind, dedupeKey, provider, betId, userId, detail }: SportsbookFindingArgs,
): Promise<void> {
  await db
    .insert(sportsbookReconciliationFinding)
    .values({
      kind,
      dedupeKey,
      provider: provider ?? null,
      betId: betId ?? null,
      userId: userId ?? null,
      detail: detail ?? {},
    })
    .onConflictDoNothing({
      target: sportsbookReconciliationFinding.dedupeKey,
      where: sql`${sportsbookReconciliationFinding.status} = 'open'`,
    });
}

export class SportsbookFindingService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly audit: AuditWritePort,
  ) {}

  async list({ page, limit, status, kind, userId }: ListSportsbookFindingsInput) {
    const filters: SQL[] = [];
    if (status) {
      filters.push(eq(sportsbookReconciliationFinding.status, status));
    }
    if (kind) {
      filters.push(eq(sportsbookReconciliationFinding.kind, kind));
    }
    if (userId) {
      filters.push(eq(sportsbookReconciliationFinding.userId, userId));
    }
    const where = filters.length > 0 ? and(...filters) : undefined;
    const [rows, [{ total }]] = await Promise.all([
      this.drizzle.db
        .select({ finding: sportsbookReconciliationFinding, currency: sportsbookBet.currency })
        .from(sportsbookReconciliationFinding)
        .leftJoin(sportsbookBet, eq(sportsbookBet.id, sportsbookReconciliationFinding.betId))
        .where(where)
        .orderBy(
          desc(sportsbookReconciliationFinding.createdAt),
          desc(sportsbookReconciliationFinding.id),
        )
        .limit(limit)
        .offset(pageToOffset(page, limit)),
      this.drizzle.db.select({ total: count() }).from(sportsbookReconciliationFinding).where(where),
    ]);
    return {
      items: rows.map((r) => toFinding(r.finding, r.currency)),
      total: Number(total),
      page,
      limit,
    };
  }

  async resolve(
    id: SportsbookFinding['id'],
    note: string,
    actor: AdminCaller,
  ): Promise<SportsbookFinding> {
    return this.drizzle.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(sportsbookReconciliationFinding)
        .where(eq(sportsbookReconciliationFinding.id, id))
        .for('update');
      if (!current) {
        throw new SportsbookFindingNotFoundError(id);
      }
      if (current.status !== 'open') {
        throw new SportsbookFindingResolvedError();
      }
      const [bet] = current.betId
        ? await tx
            .select({ currency: sportsbookBet.currency })
            .from(sportsbookBet)
            .where(eq(sportsbookBet.id, current.betId))
        : [];
      const currency = bet?.currency ?? null;
      const rows = await tx
        .update(sportsbookReconciliationFinding)
        .set({
          status: 'resolved',
          resolvedBy: actor.userId,
          resolvedAt: new Date(),
          resolutionNote: note,
        })
        .where(eq(sportsbookReconciliationFinding.id, id))
        .returning();
      const after = toFinding(
        findOneOrThrow(rows, new SportsbookFindingNotFoundError(id)),
        currency,
      );
      await this.audit.recordInTransaction(tx, {
        actorId: actor.userId,
        actorType: 'admin',
        action: 'sportsbook.finding.resolved',
        resourceType: 'sportsbook_reconciliation_finding',
        resourceId: id,
        before: toFinding(current, currency),
        after,
        ip: actor.ip,
        userAgent: actor.userAgent,
      });
      return after;
    });
  }
}

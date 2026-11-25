// The heartbeat of a ledger projection's owner, and the gate that refuses on a stale one
// (ADR-0062). Both use the ledger's clock, so the owner's clock never matters.
import type { DrizzleService, DrizzleTx } from '@openora/core/server';
import { LedgerProjectionStaleError, type LedgerProjection } from '@openora/core/contracts';
import { eq, sql } from 'drizzle-orm';
import { ledgerProjectionHeartbeat } from '../schema/index.js';

/**
 * How a projection's gate judges freshness. `remoteWriter` is read per check: a monolith or a
 * shared-database split writes the projection in the owner's transaction, so it never goes stale
 * and is never checked.
 */
export type ProjectionFreshness = {
  remoteWriter: () => boolean;
  staleMs: number;
};

type Db = DrizzleService['db'] | DrizzleTx;

export async function beat(db: Db, projection: LedgerProjection): Promise<void> {
  await db
    .insert(ledgerProjectionHeartbeat)
    .values({ projection, beatAt: sql`now()` })
    .onConflictDoUpdate({
      target: ledgerProjectionHeartbeat.projection,
      set: { beatAt: sql`now()` },
    });
}

/** Throws `LedgerProjectionStaleError` when the writer is remote and its last beat is too old. */
export async function assertFresh(
  db: Db,
  projection: LedgerProjection,
  freshness: ProjectionFreshness | undefined,
): Promise<void> {
  if (!freshness?.remoteWriter()) {
    return;
  }
  const [row] = await db
    .select({
      beatAt: ledgerProjectionHeartbeat.beatAt,
      stale: sql<boolean>`${ledgerProjectionHeartbeat.beatAt} < now() - make_interval(secs => ${freshness.staleMs / 1000})`,
    })
    .from(ledgerProjectionHeartbeat)
    .where(eq(ledgerProjectionHeartbeat.projection, projection));
  if (!row || row.stale) {
    throw new LedgerProjectionStaleError(projection, row?.beatAt ?? null);
  }
}

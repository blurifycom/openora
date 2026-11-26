import { createLogger, type DrizzleService, type DrizzleTx } from '@openora/core/server';
import { LedgerProjectionStaleError, type LedgerProjection } from '@openora/core/contracts';
import { eq, sql } from 'drizzle-orm';
import { ledgerProjectionHeartbeat } from '../schema/index.js';

const log = createLogger('wallet:projection-heartbeat');

export type ProjectionFreshness = {
  remoteWriter: () => boolean;
  staleMs: number;
  alertMs: number;
};

type Db = DrizzleService['db'] | DrizzleTx;

export type LateAlertClock = { lastAlertAt: number };

export const lateAlertClock = (): LateAlertClock => ({ lastAlertAt: 0 });

export async function beat(db: Db, projection: LedgerProjection): Promise<void> {
  await db
    .insert(ledgerProjectionHeartbeat)
    .values({ projection, beatAt: sql`now()` })
    .onConflictDoUpdate({
      target: ledgerProjectionHeartbeat.projection,
      set: { beatAt: sql`now()` },
    });
}

export async function databaseNow(db: Db): Promise<Date> {
  const [row] = await db
    .select({ now: sql`now()`.mapWith(ledgerProjectionHeartbeat.beatAt) })
    .from(sql`(select 1) as clock`);
  if (!row) {
    throw new Error('the database returned no clock');
  }
  return row.now;
}

const olderThan = (ms: number) =>
  sql<boolean>`${ledgerProjectionHeartbeat.beatAt} < now() - make_interval(secs => ${ms / 1000})`;

function alertLate(
  projection: LedgerProjection,
  beatAt: Date | null,
  alertMs: number,
  clock: LateAlertClock,
): void {
  const now = Date.now();
  if (now - clock.lastAlertAt < alertMs) {
    return;
  }
  clock.lastAlertAt = now;
  log.error(
    {
      err: new Error(`ledger projection ${projection} heartbeat is late`),
      projection,
      beatAt,
      alertMs,
    },
    'ledger projection heartbeat is late',
  );
}

export async function assertFresh(
  db: Db,
  projection: LedgerProjection,
  freshness: ProjectionFreshness | undefined,
  lateAlert: LateAlertClock,
): Promise<void> {
  if (!freshness?.remoteWriter()) {
    return;
  }
  const [row] = await db
    .select({
      beatAt: ledgerProjectionHeartbeat.beatAt,
      late: olderThan(freshness.alertMs),
      stale: olderThan(freshness.staleMs),
    })
    .from(ledgerProjectionHeartbeat)
    .where(eq(ledgerProjectionHeartbeat.projection, projection));
  if (!row || row.late) {
    alertLate(projection, row?.beatAt ?? null, freshness.alertMs, lateAlert);
  }
  if (!row || row.stale) {
    throw new LedgerProjectionStaleError(projection, row?.beatAt ?? null);
  }
}

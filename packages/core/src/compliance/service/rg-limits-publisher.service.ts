// Compliance owns every deposit and wager limit, so it is the only writer of the ledger's limits
// projection. Every limit writer calls `publish` in its own transaction, after its change; the
// backfill repairs what a writer that skipped it left behind, through `publish` too.
import { sql, and, asc, count, gt, gte, inArray, isNotNull, isNull } from 'drizzle-orm';
import { createLogger, type DrizzleDb, type DrizzleTx, type EventBus } from '@openora/core/server';
import {
  GATED_LIMIT_PERIODS,
  GATED_LIMIT_TYPES,
  RgLimitsSnapshotSchema,
  type RgLimitLedgerPort,
  type RgLimitsSnapshot,
  type User,
} from '@openora/core/contracts';
import { rgLimitVersion, userLimit } from '../schema/index.js';

const log = createLogger('compliance:rg-limits');

type Db = DrizzleDb | DrizzleTx;
type ProjectedLimit = RgLimitsSnapshot['limits'][number];
const LimitSchema = RgLimitsSnapshotSchema.shape.limits.element;

/** The effective deposit and wager limits of `userIds`, as of this statement. */
async function readLimits(db: Db, userIds: readonly User['id'][]) {
  return db
    .select({
      userId: userLimit.userId,
      limitId: userLimit.id,
      type: userLimit.type,
      period: userLimit.period,
      amount: userLimit.amount,
      currency: userLimit.currency,
      changedAt: userLimit.updatedAt,
    })
    .from(userLimit)
    .where(
      and(
        inArray(userLimit.userId, [...userIds]),
        inArray(userLimit.type, GATED_LIMIT_TYPES),
        inArray(userLimit.period, GATED_LIMIT_PERIODS),
        isNotNull(userLimit.amount),
      ),
    );
}

type LimitRow = Awaited<ReturnType<typeof readLimits>>[number];

/**
 * A row the snapshot contract rejects (a currency or amount written around the API) is projected
 * with no currency, which refuses every move it gates, so the snapshot always validates and no
 * bad row can block the write of a player lowering a limit.
 */
function projectedLimit(row: LimitRow): ProjectedLimit {
  const limit = {
    limitId: row.limitId,
    type: row.type,
    period: row.period,
    amount: row.amount,
    currency: row.currency,
    changedAt: row.changedAt.toISOString(),
  };
  const parsed = LimitSchema.safeParse(limit);
  if (parsed.success) {
    return parsed.data;
  }
  log.error(
    { userId: row.userId, limitId: row.limitId, issues: parsed.error.issues },
    'user_limit row fails the snapshot contract; projected as refusing every move',
  );
  return LimitSchema.parse({ ...limit, amount: '0', currency: null });
}

function snapshotOf(userId: User['id'], version: number, rows: readonly LimitRow[]) {
  return { userId, version, limits: rows.map(projectedLimit) } satisfies RgLimitsSnapshot;
}

export class RgLimitsPublisher {
  constructor(
    private readonly ledger: Pick<RgLimitLedgerPort, 'write'>,
    private readonly events: Pick<EventBus, 'emitInTransaction'> | null,
  ) {}

  /**
   * Bumps the user's version, then projects their limits as this transaction sees them. The bump
   * comes first: it locks the version row, so a concurrent writer of the same user waits here and
   * reads the limits only after this one commits. A failed write fails the caller's change.
   */
  async publish(tx: DrizzleTx, userId: User['id']): Promise<void> {
    const [bumped] = await tx
      .insert(rgLimitVersion)
      .values({ userId, version: 1 })
      .onConflictDoUpdate({
        target: rgLimitVersion.userId,
        set: { version: sql`${rgLimitVersion.version} + 1` },
      })
      .returning({ version: rgLimitVersion.version });
    if (!bumped) {
      throw new Error(`rg_limit_version upsert returned no row for ${userId}`);
    }
    const snapshot = snapshotOf(userId, bumped.version, await readLimits(tx, [userId]));
    await this.ledger.write(snapshot, tx);
    await this.events?.emitInTransaction(tx, 'compliance.rg_limits.changed', snapshot);
  }
}

export type BackfillRgLimitsOptions = {
  batchSize?: number;
  signal?: AbortSignal;
  /** Only users with a limit row updated since then; a removed limit waits for a full run. */
  changedSince?: Date;
  /** Emits `compliance.rg_limits.changed` for each repair; a seed passes none. */
  events?: Pick<EventBus, 'emitInTransaction'> | null;
};

/**
 * The users to compare, in batches. A full run walks `rg_limit_version` by its primary key; a heal
 * reads its window once off `user_limit_updated_at_idx`.
 */
async function* userBatches(
  db: DrizzleDb,
  batchSize: number,
  changedSince: Date | undefined,
): AsyncGenerator<User['id'][]> {
  if (changedSince) {
    const rows = await db
      .selectDistinct({ userId: userLimit.userId })
      .from(userLimit)
      .where(gte(userLimit.updatedAt, changedSince));
    for (let i = 0; i < rows.length; i += batchSize) {
      yield rows.slice(i, i + batchSize).map((row) => row.userId);
    }
    return;
  }
  let after: User['id'] | null = null;
  for (;;) {
    const rows = await db
      .select({ userId: rgLimitVersion.userId })
      .from(rgLimitVersion)
      .where(after === null ? undefined : gt(rgLimitVersion.userId, after))
      .orderBy(asc(rgLimitVersion.userId))
      .limit(batchSize);
    if (rows.length === 0) {
      return;
    }
    yield rows.map((row) => row.userId);
    after = rows.at(-1)?.userId ?? null;
  }
}

/**
 * Brings the ledger's limits projection up to date: compares each user's limits with the ledger
 * in keyset batches of short reads, and re-publishes every user that drifted, each in its own
 * short transaction under a fresh version. Never overwrites at an equal version, so a late
 * outbox delivery cannot undo a repair. Idempotent; safe at every boot and from a seed. Returns
 * how many users it repaired.
 */
export async function backfillRgLimits(
  db: DrizzleDb,
  ledger: Pick<RgLimitLedgerPort, 'write' | 'drifted'>,
  { batchSize = 500, signal, changedSince, events = null }: BackfillRgLimitsOptions = {},
): Promise<number> {
  const publisher = new RgLimitsPublisher(ledger, events);
  if (!changedSince) {
    // A limit written by a replica from before ADR-0055 has no version row; give it one, so the
    // walk below reaches it. Existing rows are left alone, unlocked.
    await db.execute(sql`
      insert into ${rgLimitVersion} (user_id, version)
      select distinct ${userLimit.userId}, 0 from ${userLimit}
      on conflict do nothing
    `);
    const [unpinned] = await db
      .select({ rows: count() })
      .from(userLimit)
      .where(and(isNull(userLimit.currency), isNotNull(userLimit.amount)));
    if (unpinned && unpinned.rows > 0) {
      log.warn(
        { rows: unpinned.rows },
        'money limits without a currency refuse every move until an admin override sets one',
      );
    }
  }
  let repaired = 0;
  for await (const userIds of userBatches(db, batchSize, changedSince)) {
    signal?.throwIfAborted();
    // One snapshot for both reads: a version read after a newer commit than the limits would
    // label older limits with the newer version.
    const { versions, rows } = await db.transaction(
      async (tx) => ({
        versions: await tx
          .select()
          .from(rgLimitVersion)
          .where(inArray(rgLimitVersion.userId, userIds)),
        rows: await readLimits(tx, userIds),
      }),
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
    const versionOf = new Map(versions.map((row) => [row.userId, row.version]));
    const rowsOf = new Map<User['id'], LimitRow[]>();
    for (const row of rows) {
      rowsOf.set(row.userId, [...(rowsOf.get(row.userId) ?? []), row]);
    }
    const drifted = await ledger.drifted(
      userIds.map((userId) =>
        snapshotOf(userId, versionOf.get(userId) ?? 0, rowsOf.get(userId) ?? []),
      ),
    );
    for (const userId of drifted) {
      signal?.throwIfAborted();
      await db.transaction((tx) => publisher.publish(tx, userId));
      repaired += 1;
    }
  }
  return repaired;
}

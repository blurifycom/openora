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

export function projectedLimit(row: LimitRow): ProjectedLimit {
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
    private readonly ledger: Pick<RgLimitLedgerPort, 'write' | 'remote'>,
    private readonly events: Pick<EventBus, 'emitInTransaction'> | null,
  ) {}

  async publish(
    tx: DrizzleTx,
    userId: User['id'],
    { loosening = false }: { loosening?: boolean } = {},
  ): Promise<void> {
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
    if (!loosening || !this.ledger.remote) {
      await this.ledger.write(snapshot, tx);
    }
    await this.events?.emitInTransaction(tx, 'compliance.rg_limits.changed', snapshot);
  }
}

export type BackfillRgLimitsOptions = {
  batchSize?: number;
  signal?: AbortSignal;
  changedSince?: Date;
  events?: Pick<EventBus, 'emitInTransaction'> | null;
};

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
    const userIds = await versionedUsers(db, after, batchSize);
    if (userIds.length === 0) {
      return;
    }
    yield userIds;
    after = userIds.at(-1) ?? null;
  }
}

async function versionedUsers(
  db: DrizzleDb,
  after: User['id'] | null,
  limit: number,
): Promise<User['id'][]> {
  const rows = await db
    .select({ userId: rgLimitVersion.userId })
    .from(rgLimitVersion)
    .where(after === null ? undefined : gt(rgLimitVersion.userId, after))
    .orderBy(asc(rgLimitVersion.userId))
    .limit(limit);
  return rows.map((row) => row.userId);
}

export async function readSnapshots(
  db: DrizzleDb,
  userIds: readonly User['id'][],
): Promise<RgLimitsSnapshot[]> {
  const { versions, rows } = await db.transaction(
    async (tx) => ({
      versions: await tx
        .select()
        .from(rgLimitVersion)
        .where(inArray(rgLimitVersion.userId, [...userIds])),
      rows: await readLimits(tx, userIds),
    }),
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
  const versionOf = new Map(versions.map((row) => [row.userId, row.version]));
  const rowsOf = new Map<User['id'], LimitRow[]>();
  for (const row of rows) {
    rowsOf.set(row.userId, [...(rowsOf.get(row.userId) ?? []), row]);
  }
  return userIds.map((userId) =>
    snapshotOf(userId, versionOf.get(userId) ?? 0, rowsOf.get(userId) ?? []),
  );
}

export async function rgLimitsPage(
  db: DrizzleDb,
  after: User['id'] | null,
  limit: number,
): Promise<RgLimitsSnapshot[]> {
  return readSnapshots(db, await versionedUsers(db, after, limit));
}

export async function backfillRgLimits(
  db: DrizzleDb,
  ledger: Pick<RgLimitLedgerPort, 'write' | 'drifted'>,
  { batchSize = 500, signal, changedSince, events = null }: BackfillRgLimitsOptions = {},
): Promise<number> {
  const publisher = new RgLimitsPublisher(ledger, events);
  if (!changedSince) {
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
    const drifted = await ledger.drifted(await readSnapshots(db, userIds));
    for (const userId of drifted) {
      signal?.throwIfAborted();
      await db.transaction((tx) => publisher.publish(tx, userId));
      repaired += 1;
    }
  }
  return repaired;
}

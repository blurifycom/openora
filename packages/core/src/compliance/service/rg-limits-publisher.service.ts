// Compliance owns every deposit and wager limit, so it is the only writer of the ledger's limits
// projection. Every limit writer calls `publish` in its own transaction, after its change; the
// boot backfill heals what a writer from before ADR-0055 left behind.
import { sql, and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { DrizzleDb, DrizzleTx, EventBus } from '@openora/core/server';
import {
  GATED_LIMIT_PERIODS,
  GATED_LIMIT_TYPES,
  type RgLimitLedgerPort,
  type RgLimitsPublisherPort,
  type RgLimitsSnapshot,
  type User,
} from '@openora/core/contracts';
import { player } from '@openora/core/pam/schema/profile';
import { rgLimitVersion, userLimit } from '../schema/index.js';

type Db = DrizzleDb | DrizzleTx;

/** The effective deposit and wager limits of `userIds`, as of this statement. */
async function readLimits(db: Db, userIds: readonly User['id'][]) {
  return db
    .select({
      userId: userLimit.userId,
      limitId: userLimit.id,
      type: userLimit.type,
      period: userLimit.period,
      amount: userLimit.amount,
      // A limit whose currency was never resolved is denominated in the player's currency.
      currency: sql<string | null>`coalesce(${userLimit.currency}, ${player.currency})`,
      changedAt: userLimit.updatedAt,
    })
    .from(userLimit)
    .leftJoin(player, eq(player.userId, userLimit.userId))
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

function snapshotOf(userId: User['id'], version: number, rows: readonly LimitRow[]) {
  return {
    userId,
    version,
    limits: rows.map((row) => ({
      limitId: row.limitId,
      type: row.type as RgLimitsSnapshot['limits'][number]['type'],
      period: row.period as RgLimitsSnapshot['limits'][number]['period'],
      amount: row.amount as string,
      currency: row.currency,
      changedAt: row.changedAt.toISOString(),
    })),
  } satisfies RgLimitsSnapshot;
}

export class RgLimitsPublisher implements RgLimitsPublisherPort {
  constructor(
    private readonly ledger: Pick<RgLimitLedgerPort, 'write'>,
    private readonly events: Pick<EventBus, 'emitInTransaction'>,
  ) {}

  /**
   * Bumps the user's version, then projects their limits as this transaction sees them. The bump
   * comes first: it locks the version row, so a concurrent writer of the same user waits here and
   * reads the limits only after this one commits. A failed write fails the caller's change.
   */
  async publish(tx: unknown, userId: User['id']): Promise<void> {
    const db = tx as DrizzleTx;
    const [bumped] = await db
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
    const snapshot = snapshotOf(userId, bumped.version, await readLimits(db, [userId]));
    await this.ledger.write(snapshot, db);
    await this.events.emitInTransaction(db, 'compliance.rg_limits.changed', snapshot);
  }
}

export type BackfillRgLimitsOptions = {
  batchSize?: number;
  signal?: AbortSignal;
  /** Only users with a limit row updated since then; a removed limit waits for a full run. */
  changedSince?: Date;
};

/**
 * Brings the ledger's limits projection up to date for every user with a limit or a version:
 * keyset batches of short reads, each handed to `reconcile`, which writes only the users whose
 * projection is missing, older, or different, and never locks the rest. Idempotent; safe at
 * every boot and from a seed. Returns how many users it wrote.
 */
export async function backfillRgLimits(
  db: DrizzleDb,
  ledger: Pick<RgLimitLedgerPort, 'reconcile'>,
  { batchSize = 500, signal, changedSince }: BackfillRgLimitsOptions = {},
): Promise<number> {
  let written = 0;
  let after: User['id'] | null = null;
  const users = changedSince
    ? sql`(select distinct ${userLimit.userId} as user_id from ${userLimit}
        where ${userLimit.updatedAt} >= ${changedSince}) as users`
    : sql`(select ${userLimit.userId} as user_id from ${userLimit}
        union select ${rgLimitVersion.userId} from ${rgLimitVersion}) as users`;
  for (;;) {
    signal?.throwIfAborted();
    const page = await db.execute<{ user_id: string }>(sql`
      select user_id from ${users}
      ${after === null ? sql`` : sql`where user_id > ${after}`}
      order by user_id
      limit ${batchSize}
    `);
    const userIds: User['id'][] = page.rows.map((row) => row.user_id);
    if (userIds.length === 0) {
      return written;
    }
    // One snapshot for both reads: a version read after a newer commit than the limits would
    // label older limits with the newer version, and `reconcile` would write them.
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
    signal?.throwIfAborted();
    written += await ledger.reconcile(
      userIds.map((userId) =>
        snapshotOf(userId, versionOf.get(userId) ?? 0, rowsOf.get(userId) ?? []),
      ),
    );
    after = userIds.at(-1) ?? null;
  }
}

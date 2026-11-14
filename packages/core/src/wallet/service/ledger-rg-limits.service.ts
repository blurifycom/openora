// The ledger's deposit and wager limit gate, over its own `ledger_user_limit` projection and its own
// `wallet_transaction` spend. Compliance, the owner of every limit, writes the projection through
// RG_LIMIT_LEDGER in the transaction that changes a limit, and repairs it from the
// `compliance.rg_limits.changed` outbox event and its boot backfill. See ADR-0055.
import {
  createLogger,
  moneyAdd,
  moneyCompare,
  withAdvisoryXactLocks,
  type DrizzleDb,
  type DrizzleService,
  type DrizzleTx,
} from '@openora/core/server';
import {
  RgLimitsSnapshotSchema,
  RgRateUnavailableError,
  limitSlotKey,
  periodWindow,
  type ExchangeRateReader,
  type LimitPeriod,
  type LimitType,
  type RgLimitDecision,
  type RgLimitLedgerPort,
  type RgLimitsPort,
  type RgLimitsSnapshot,
  type User,
} from '@openora/core/contracts';
import { and, asc, desc, eq, gte, inArray, lt, lte, notInArray, sql } from 'drizzle-orm';
import {
  LOSS_LEGS,
  WAGER_LEGS,
  ledgerUserLimit,
  ledgerUserLimitVersion,
  wallet,
  walletTransaction,
  type PlayLeg,
} from '../schema/index.js';

const log = createLogger('wallet:rg-limits');

type Db = DrizzleDb | DrizzleTx;
type GatedType = RgLimitsSnapshot['limits'][number]['type'];
type LimitRow = typeof ledgerUserLimit.$inferSelect;
type Refusal = Extract<RgLimitDecision, { allowed: false }>;

function rowsOf(snapshot: RgLimitsSnapshot): LimitRow[] {
  return snapshot.limits.map((limit) => ({
    limitId: limit.limitId,
    userId: snapshot.userId,
    type: limit.type,
    period: limit.period,
    amount: limit.amount,
    currency: limit.currency,
    changedAt: new Date(limit.changedAt),
  }));
}

function sameRows(held: readonly LimitRow[], wanted: readonly LimitRow[]): boolean {
  const heldById = new Map(held.map((row) => [row.limitId, row]));
  return (
    held.length === wanted.length &&
    wanted.every((row) => {
      const current = heldById.get(row.limitId);
      return (
        current !== undefined &&
        current.type === row.type &&
        current.period === row.period &&
        moneyCompare(current.amount, row.amount) === 0 &&
        current.currency === row.currency &&
        current.changedAt.getTime() === row.changedAt.getTime()
      );
    })
  );
}

/** Makes `userId`'s rows exactly `rows`, touching only the ones that differ. */
async function replaceRows(db: Db, userId: User['id'], rows: readonly LimitRow[]) {
  const ids = rows.map((row) => row.limitId);
  await db
    .delete(ledgerUserLimit)
    .where(
      and(
        eq(ledgerUserLimit.userId, userId),
        ids.length > 0 ? notInArray(ledgerUserLimit.limitId, ids) : undefined,
      ),
    );
  if (rows.length === 0) {
    return;
  }
  await db
    .insert(ledgerUserLimit)
    .values([...rows])
    .onConflictDoUpdate({
      target: ledgerUserLimit.limitId,
      set: {
        userId: sql`excluded.user_id`,
        type: sql`excluded.type`,
        period: sql`excluded.period`,
        amount: sql`excluded.amount`,
        currency: sql`excluded.currency`,
        changedAt: sql`excluded.changed_at`,
      },
      setWhere: sql`(${ledgerUserLimit.userId}, ${ledgerUserLimit.type}, ${ledgerUserLimit.period},
          ${ledgerUserLimit.amount}, ${ledgerUserLimit.currency}, ${ledgerUserLimit.changedAt})
        IS DISTINCT FROM (excluded.user_id, excluded.type, excluded.period, excluded.amount,
          excluded.currency, excluded.changed_at)`,
    });
}

export class LedgerRgLimitsService implements RgLimitsPort, RgLimitLedgerPort {
  constructor(
    private readonly drizzle: Pick<DrizzleService, 'db'>,
    private readonly rates: ExchangeRateReader | undefined,
  ) {}

  checkDeposit(
    tx: unknown,
    userId: User['id'],
    amount: string,
    currency: string,
  ): Promise<RgLimitDecision> {
    return this.check(tx as DrizzleTx, userId, 'deposit', amount, currency);
  }

  checkWager(
    tx: unknown,
    userId: User['id'],
    amount: string,
    currency: string,
  ): Promise<RgLimitDecision> {
    return this.check(tx as DrizzleTx, userId, 'wager', amount, currency);
  }

  async referenceCurrency(tx: unknown, userId: User['id']): Promise<string | null> {
    const [row] = await (tx as DrizzleTx)
      .select({ currency: ledgerUserLimit.currency })
      .from(ledgerUserLimit)
      .where(eq(ledgerUserLimit.userId, userId))
      .orderBy(sql`${ledgerUserLimit.type} = 'deposit' desc`, desc(ledgerUserLimit.changedAt))
      .limit(1);
    return row?.currency?.toUpperCase() ?? null;
  }

  private readLimits(db: DrizzleTx, userId: User['id'], type: GatedType) {
    return db
      .select()
      .from(ledgerUserLimit)
      .where(and(eq(ledgerUserLimit.userId, userId), eq(ledgerUserLimit.type, type)))
      .orderBy(asc(ledgerUserLimit.period), asc(ledgerUserLimit.limitId));
  }

  private async check(
    db: DrizzleTx,
    userId: User['id'],
    type: GatedType,
    amount: string,
    amountCurrency: string,
  ): Promise<RgLimitDecision> {
    const scanned = await this.readLimits(db, userId, type);
    if (scanned.length === 0) {
      return { allowed: true };
    }
    // Re-read under the slot locks: the scan is unlocked, so a lower limit can commit between the
    // two. Its writer holds the same slot lock, so once the lock is ours the projection row is the
    // committed truth for the rest of the caller's transaction.
    const slots = [...new Set(scanned.map((row) => limitSlotKey(userId, row.type, row.period)))];
    const limits = await withAdvisoryXactLocks(db, slots, () => this.readLimits(db, userId, type));
    const now = new Date();
    for (const row of limits) {
      const refusal = await this.refusalOf(db, row, amount, amountCurrency, now);
      if (refusal) {
        return refusal;
      }
    }
    return { allowed: true };
  }

  private async refusalOf(
    db: DrizzleTx,
    row: LimitRow,
    amount: string,
    amountCurrency: string,
    now: Date,
  ): Promise<Refusal | null> {
    const limit = row.amount;
    const base = { allowed: false, limitType: row.type, period: row.period, limit } as const;
    if (row.currency === null) {
      return { ...base, used: limit, currency: null };
    }
    const limitCurrency = row.currency;
    const rateUnavailable: Refusal = { ...base, used: limit, currency: limitCurrency };

    let used: string;
    try {
      used = await this.spendFor(
        db,
        row.userId,
        row.type,
        row.period,
        periodWindow(row.period, now).from,
        limitCurrency,
      );
    } catch (err) {
      if (err instanceof RgRateUnavailableError) {
        return rateUnavailable;
      }
      throw err;
    }
    const attempted =
      amountCurrency === limitCurrency
        ? amount
        : ((await this.rates?.convert(amount, amountCurrency, limitCurrency, db)) ?? null);
    if (attempted === null) {
      return rateUnavailable;
    }
    if (moneyCompare(moneyAdd(used, attempted), limit) > 0) {
      return {
        ...base,
        used: moneyCompare(used, '0') < 0 ? '0' : used,
        currency: limitCurrency,
      };
    }
    return null;
  }

  async write(snapshot: RgLimitsSnapshot, tx: unknown): Promise<void> {
    const db = tx as DrizzleTx;
    const parsed = RgLimitsSnapshotSchema.parse(snapshot);
    const [held] = await db
      .select({ version: ledgerUserLimitVersion.version })
      .from(ledgerUserLimitVersion)
      .where(eq(ledgerUserLimitVersion.userId, parsed.userId))
      .for('update');
    if (held && held.version > parsed.version) {
      // The writer holds compliance's version row lock and its version is the truth: a higher one
      // here came from outside compliance. Overwrite it, so the ledger never keeps limits
      // compliance does not have.
      log.error(
        { userId: parsed.userId, heldVersion: held.version, version: parsed.version },
        'ledger_user_limit held a version ahead of compliance; overwritten',
      );
    }
    await db
      .insert(ledgerUserLimitVersion)
      .values({ userId: parsed.userId, version: parsed.version })
      .onConflictDoUpdate({
        target: ledgerUserLimitVersion.userId,
        set: { version: sql`excluded.version`, updatedAt: sql`now()` },
      });
    await replaceRows(db, parsed.userId, rowsOf(parsed));
  }

  /** The newest valid snapshot per user; a snapshot the contract rejects is logged and skipped. */
  private newestPerUser(snapshots: readonly RgLimitsSnapshot[]): Map<User['id'], RgLimitsSnapshot> {
    const newest = new Map<User['id'], RgLimitsSnapshot>();
    for (const candidate of snapshots) {
      const parsed = RgLimitsSnapshotSchema.safeParse(candidate);
      if (!parsed.success) {
        log.error({ issues: parsed.error.issues }, 'invalid rg limits snapshot skipped');
        continue;
      }
      const snapshot = parsed.data;
      if ((newest.get(snapshot.userId)?.version ?? -1) < snapshot.version) {
        newest.set(snapshot.userId, snapshot);
      }
    }
    return newest;
  }

  /** Unlocked reads of the held versions and rows of `userIds`. */
  private async held(userIds: User['id'][]) {
    const db = this.drizzle.db;
    const [versions, rows] = await Promise.all([
      db
        .select()
        .from(ledgerUserLimitVersion)
        .where(inArray(ledgerUserLimitVersion.userId, userIds)),
      db.select().from(ledgerUserLimit).where(inArray(ledgerUserLimit.userId, userIds)),
    ]);
    const rowsOfUser = new Map<User['id'], LimitRow[]>();
    for (const row of rows) {
      rowsOfUser.set(row.userId, [...(rowsOfUser.get(row.userId) ?? []), row]);
    }
    return {
      versionOf: new Map(versions.map((row) => [row.userId, row.version])),
      rowsOf: (userId: User['id']) => rowsOfUser.get(userId) ?? [],
    };
  }

  async reconcile(snapshots: readonly RgLimitsSnapshot[]): Promise<number> {
    const newest = this.newestPerUser(snapshots);
    if (newest.size === 0) {
      return 0;
    }
    // Unlocked: a user already at or past the snapshot's version is never locked. Only a strictly
    // newer version is written; an equal one may be a late delivery of rows a repair replaced.
    const { versionOf } = await this.held([...newest.keys()]);
    const newer = [...newest.values()].filter(
      (snapshot) => (versionOf.get(snapshot.userId) ?? -1) < snapshot.version,
    );

    let written = 0;
    for (const snapshot of newer) {
      const wrote = await this.drizzle.db.transaction(async (tx) => {
        const inserted = await tx
          .insert(ledgerUserLimitVersion)
          .values({ userId: snapshot.userId, version: snapshot.version })
          .onConflictDoNothing()
          .returning({ userId: ledgerUserLimitVersion.userId });
        if (inserted.length === 0) {
          const updated = await tx
            .update(ledgerUserLimitVersion)
            .set({ version: snapshot.version, updatedAt: sql`now()` })
            .where(
              and(
                eq(ledgerUserLimitVersion.userId, snapshot.userId),
                lt(ledgerUserLimitVersion.version, snapshot.version),
              ),
            )
            .returning({ userId: ledgerUserLimitVersion.userId });
          if (updated.length === 0) {
            return false;
          }
        }
        await replaceRows(tx, snapshot.userId, rowsOf(snapshot));
        return true;
      });
      written += wrote ? 1 : 0;
    }
    return written;
  }

  async drifted(snapshots: readonly RgLimitsSnapshot[]): Promise<User['id'][]> {
    return this.differing(snapshots, (held, wanted) => held !== wanted);
  }

  /**
   * As `drifted`, but a projection ahead of its snapshot is not behind: the owner moved on after
   * it was read, so only a lower version, or the same one with other rows, counts.
   */
  async behind(snapshots: readonly RgLimitsSnapshot[]): Promise<User['id'][]> {
    return this.differing(snapshots, (held, wanted) => held < wanted);
  }

  private async differing(
    snapshots: readonly RgLimitsSnapshot[],
    versionDiffers: (held: number, wanted: number) => boolean,
  ): Promise<User['id'][]> {
    const newest = this.newestPerUser(snapshots);
    if (newest.size === 0) {
      return [];
    }
    const { versionOf, rowsOf: heldRowsOf } = await this.held([...newest.keys()]);
    return [...newest.values()]
      .filter((snapshot) => {
        const held = versionOf.get(snapshot.userId) ?? 0;
        return (
          versionDiffers(held, snapshot.version) ||
          (held === snapshot.version && !sameRows(heldRowsOf(snapshot.userId), rowsOf(snapshot)))
        );
      })
      .map((snapshot) => snapshot.userId);
  }

  async spendFor(
    db: unknown,
    userId: User['id'],
    type: LimitType,
    period: LimitPeriod,
    from: Date,
    limitCurrency: string,
  ): Promise<string> {
    const conn = db as Db;
    const groups =
      type === 'deposit'
        ? await this.depositsByCurrency(conn, userId, from)
        : await this.playByCurrency(conn, userId, from, type === 'loss' ? LOSS_LEGS : WAGER_LEGS);
    let total = '0';
    for (const group of groups) {
      if (group.currency === limitCurrency) {
        total = moneyAdd(total, group.total);
        continue;
      }
      const converted = await this.rates?.convert(group.total, group.currency, limitCurrency, conn);
      if (converted === null || converted === undefined) {
        throw new RgRateUnavailableError(type, period, group.currency, limitCurrency);
      }
      total = moneyAdd(total, converted);
    }
    return total;
  }

  private async depositsByCurrency(db: Db, userId: User['id'], from: Date) {
    const depositedAt = sql<Date>`coalesce(${walletTransaction.reviewedAt}, ${walletTransaction.createdAt})`;
    return db
      .select({
        currency: walletTransaction.currency,
        total: sql<string>`coalesce(sum(${walletTransaction.amount}), 0)`,
      })
      .from(walletTransaction)
      .innerJoin(wallet, eq(wallet.id, walletTransaction.walletId))
      .where(
        and(
          eq(wallet.userId, userId),
          eq(walletTransaction.type, 'deposit'),
          // A pending deposit is a reservation the wallet took under the player's deposit
          // lock before charging the PSP. Counting it is what stops two concurrent deposits
          // from spending the same headroom; it is released to `failed` if the charge fails.
          inArray(walletTransaction.status, ['completed', 'pending']),
          // A held deposit an operator released later is spent when it reached the balance
          // (reviewedAt), not when it landed on chain; every other deposit has no reviewedAt.
          gte(depositedAt, from),
          // The database stamps createdAt, so the upper bound reads the same clock. An
          // app-side new Date() that trails the database by a millisecond would drop a
          // just-committed deposit out of the player's spend.
          lte(depositedAt, sql`now()`),
        ),
      )
      .groupBy(walletTransaction.currency);
  }

  /**
   * Play from the wallet ledger, whatever product it was on, netted per round. The ledger does not
   * say which bet a reversal reverses, so a round's reversals, wins and win reversals count only
   * when every bet of it was placed inside the window. A round that started before it adds its
   * stakes plus whatever its win reversals here take back beyond its wins here, so a resettled
   * payout lands in the period it is collected (ADR-0046). A round's stake never nets below 0, and
   * a leg without a round id never offsets one.
   */
  private async playByCurrency(db: Db, userId: User['id'], from: Date, legs: readonly PlayLeg[]) {
    const types = sql.join(
      legs.map((leg) => sql`(${leg.type}, ${leg.direction})`),
      sql`, `,
    );
    const result = await db.execute<{ currency: string; total: string }>(sql`
      with legs as (
        select t.wallet_id, t.provider_name, t.external_round_id, t.currency, t.type,
          case when t.direction = 'debit' then t.amount else -t.amount end as signed
        from ${walletTransaction} t
        join ${wallet} w on w.id = t.wallet_id
        where w.user_id = ${userId}
          and t.status = 'completed'
          and t.created_at >= ${from}
          and (t.type, t.direction) in (${types})
      ),
      rounds as (
        select wallet_id, provider_name, external_round_id, currency,
          coalesce(sum(signed) filter (where type = 'bet'), 0) as stake,
          coalesce(sum(signed) filter (where type in ('bet', 'bet_reversal')), 0) as net_stake,
          coalesce(sum(signed) filter (where type not in ('bet', 'bet_reversal')), 0) as net_win,
          coalesce(sum(signed) filter (where type = 'win_reversal'), 0) as reclaimed,
          coalesce(sum(signed) filter (where type = 'win'), 0) as paid,
          external_round_id is not null
            and count(*) filter (where type = 'bet') > 0
            and count(*) filter (where type <> 'bet') > 0 as nets
        from legs
        group by wallet_id, provider_name, external_round_id, currency
      ),
      opened_before as (
        select distinct p.wallet_id, p.provider_name, p.external_round_id
        from ${walletTransaction} p
        join ${wallet} w on w.id = p.wallet_id
        join rounds r on r.wallet_id = p.wallet_id
          and r.provider_name = p.provider_name
          and r.external_round_id = p.external_round_id
        where w.user_id = ${userId}
          and r.nets
          and p.type = 'bet'
          and p.status = 'completed'
          and p.created_at < ${from}
      )
      select r.currency,
        greatest(sum(
          case when r.nets and o.wallet_id is null then greatest(r.net_stake, 0) + r.net_win
          else r.stake + greatest(r.reclaimed + r.paid, 0) end
        ), 0) as total
      from rounds r
      left join opened_before o on o.wallet_id = r.wallet_id
        and o.provider_name = r.provider_name
        and o.external_round_id = r.external_round_id
      group by r.currency
    `);
    return result.rows;
  }
}

/** The limits projection over a bare database handle, for a seed script that boots no container. */
export function ledgerRgLimits(
  db: DrizzleService['db'],
  rates?: ExchangeRateReader,
): RgLimitLedgerPort & RgLimitsPort {
  return new LedgerRgLimitsService({ db }, rates);
}

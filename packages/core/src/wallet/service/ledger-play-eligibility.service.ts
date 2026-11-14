// The ledger's view of whether a user may stake: `ledger_play_eligibility`. Identity, the owner
// of every input, writes it through PLAY_ELIGIBILITY_PROJECTION in the transaction that changes
// one, and repairs it from the `identity.play_eligibility.changed` outbox event and its backfill.
// A stake reads this table, never the identity tables. See ADR-0054.
import { createLogger, type DrizzleService, type DrizzleTx } from '@openora/core/server';
import {
  PlayEligibilitySnapshotSchema,
  playRefusalOf,
  type PlayEligibilityPort,
  type PlayEligibilityProjectionPort,
  type PlayEligibilitySnapshot,
  type PlayEligibilityState,
  type PlayRefusal,
  type User,
} from '@openora/core/contracts';
import { eq, inArray, sql } from 'drizzle-orm';
import { ledgerPlayEligibility } from '../schema/index.js';

const log = createLogger('wallet:play-eligibility');

type ProjectionRow = PlayEligibilityState & { userId: User['id']; version: number };

const toDate = (iso: string | null) => (iso === null ? null : new Date(iso));

function rowOf(input: PlayEligibilitySnapshot): ProjectionRow {
  const snapshot = PlayEligibilitySnapshotSchema.parse(input);
  return {
    ...snapshot,
    rgBlockedUntil: toDate(snapshot.rgBlockedUntil),
    banExpires: toDate(snapshot.banExpires),
  };
}

const sameInstant = (a: Date | null, b: Date | null) => a?.getTime() === b?.getTime();

function sameState(a: PlayEligibilityState, b: PlayEligibilityState): boolean {
  return (
    a.rgBlocked === b.rgBlocked &&
    sameInstant(a.rgBlockedUntil, b.rgBlockedUntil) &&
    a.isActive === b.isActive &&
    a.banned === b.banned &&
    sameInstant(a.banExpires, b.banExpires) &&
    a.status === b.status
  );
}

const fromExcluded = {
  rgBlocked: sql`excluded.rg_blocked`,
  rgBlockedUntil: sql`excluded.rg_blocked_until`,
  isActive: sql`excluded.is_active`,
  banned: sql`excluded.banned`,
  banExpires: sql`excluded.ban_expires`,
  status: sql`excluded.status`,
  version: sql`excluded.version`,
  updatedAt: sql`now()`,
};

export class LedgerPlayEligibilityService
  implements Required<PlayEligibilityPort>, PlayEligibilityProjectionPort
{
  constructor(private readonly drizzle: Pick<DrizzleService, 'db'>) {}

  private async read(userId: User['id'], tx?: unknown) {
    const db = (tx as DrizzleTx | undefined) ?? this.drizzle.db;
    const query = db
      .select()
      .from(ledgerPlayEligibility)
      .where(eq(ledgerPlayEligibility.userId, userId))
      .limit(1);
    const [row] = tx ? await query.for('share') : await query;
    return row;
  }

  async isRestricted(userId: User['id'], tx?: unknown): Promise<boolean> {
    const row = await this.read(userId, tx);
    return (
      !row || (row.rgBlocked && (row.rgBlockedUntil === null || row.rgBlockedUntil > new Date()))
    );
  }

  async checkPlay(userId: User['id'], tx?: unknown): Promise<PlayRefusal | null> {
    const row = await this.read(userId, tx);
    return row ? playRefusalOf(row) : 'account_inactive';
  }

  async write(snapshot: PlayEligibilitySnapshot, tx: unknown): Promise<void> {
    const db = tx as DrizzleTx;
    const row = rowOf(snapshot);
    const [held] = await db
      .select({ version: ledgerPlayEligibility.version })
      .from(ledgerPlayEligibility)
      .where(eq(ledgerPlayEligibility.userId, row.userId))
      .limit(1);
    if (held && held.version > row.version) {
      // The writer holds the user row lock and its version is the truth: a higher one here came
      // from outside identity. Overwrite it, so the ledger never keeps a state identity did not.
      log.error(
        { userId: row.userId, heldVersion: held.version, version: row.version },
        'ledger_play_eligibility held a version ahead of identity; overwritten',
      );
    }
    await db
      .insert(ledgerPlayEligibility)
      .values(row)
      .onConflictDoUpdate({ target: ledgerPlayEligibility.userId, set: fromExcluded });
  }

  async reconcile(snapshots: readonly PlayEligibilitySnapshot[]): Promise<number> {
    const newest = new Map<User['id'], ProjectionRow>();
    for (const row of snapshots.map(rowOf)) {
      if ((newest.get(row.userId)?.version ?? -1) < row.version) {
        newest.set(row.userId, row);
      }
    }
    if (newest.size === 0) {
      return 0;
    }
    const db = this.drizzle.db;
    // Unlocked: the upsert's own condition decides, so a row nobody needs to change is never locked.
    const held = await db
      .select()
      .from(ledgerPlayEligibility)
      .where(inArray(ledgerPlayEligibility.userId, [...newest.keys()]));
    const heldBy = new Map(held.map((row) => [row.userId, row]));
    const stale = [...newest.values()].filter((row) => {
      const current = heldBy.get(row.userId);
      return (
        !current ||
        current.version < row.version ||
        (current.version === row.version && !sameState(current, row))
      );
    });
    if (stale.length === 0) {
      return 0;
    }
    const result = await db
      .insert(ledgerPlayEligibility)
      .values(stale)
      .onConflictDoUpdate({
        target: ledgerPlayEligibility.userId,
        set: fromExcluded,
        setWhere: sql`${ledgerPlayEligibility.version} < excluded.version
          OR (${ledgerPlayEligibility.version} = excluded.version
            AND (${ledgerPlayEligibility.rgBlocked}, ${ledgerPlayEligibility.rgBlockedUntil},
                 ${ledgerPlayEligibility.isActive}, ${ledgerPlayEligibility.banned},
                 ${ledgerPlayEligibility.banExpires}, ${ledgerPlayEligibility.status})
            IS DISTINCT FROM (excluded.rg_blocked, excluded.rg_blocked_until, excluded.is_active,
                 excluded.banned, excluded.ban_expires, excluded.status))`,
      });
    return result.rowCount ?? 0;
  }
}

/** The projection over a bare database handle, for a seed script that boots no container. */
export function ledgerPlayEligibilityProjection(
  db: DrizzleService['db'],
): PlayEligibilityProjectionPort {
  return new LedgerPlayEligibilityService({ db });
}

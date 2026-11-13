// The ledger's view of whether a user may stake: `ledger_play_eligibility`, written by identity
// through `LedgerApiV1.setPlayEligibility` and the `identity.play_eligibility.changed` event, and
// healed by the boot backfill. A stake reads this table, never the identity tables. Every write
// keeps the highest `version`, so a redelivered or reordered snapshot leaves a newer row as it is.
import {
  withAdvisoryXactLock,
  type DrizzleDb,
  type DrizzleService,
  type DrizzleTx,
} from '@openora/core/server';
import {
  LedgerV1SetPlayEligibilityArgsSchema,
  playRefusalOf,
  type LedgerV1SetPlayEligibilityArgs,
  type PlayEligibilityPort,
  type PlayEligibilityState,
  type PlayRefusal,
  type User,
} from '@openora/core/contracts';
import { user } from '@openora/core/pam/schema/identity';
import { player } from '@openora/core/pam/schema/profile';
import { eq, sql } from 'drizzle-orm';
import { ledgerPlayEligibility } from '../schema/index.js';

const BACKFILL_LOCK_KEY = 'wallet:ledger_play_eligibility:backfill';
const userLockKey = (userId: User['id']) => `wallet:ledger_play_eligibility:${userId}`;

const BLOCKING_STATUSES = new Set<PlayEligibilityState['status']>([
  'self_excluded',
  'suspended',
  'closed',
]);

/** The later of two block ends, where null is a block without an end. */
const laterEnd = (a: Date | null, b: Date | null) =>
  a === null || b === null ? null : a > b ? a : b;

/**
 * The stricter of two states, field by field: what `restrict` stores, so a restriction pushed
 * before its writer commits never loosens a block the ledger already holds.
 */
export function stricterOf(
  held: PlayEligibilityState,
  incoming: PlayEligibilityState,
): PlayEligibilityState {
  const rgBlocked = held.rgBlocked || incoming.rgBlocked;
  const banned = held.banned || incoming.banned;
  return {
    rgBlocked,
    rgBlockedUntil:
      held.rgBlocked && incoming.rgBlocked
        ? laterEnd(held.rgBlockedUntil, incoming.rgBlockedUntil)
        : held.rgBlocked
          ? held.rgBlockedUntil
          : incoming.rgBlockedUntil,
    isActive: held.isActive && incoming.isActive,
    banned,
    banExpires:
      held.banned && incoming.banned
        ? laterEnd(held.banExpires, incoming.banExpires)
        : held.banned
          ? held.banExpires
          : incoming.banExpires,
    status:
      BLOCKING_STATUSES.has(incoming.status) || !BLOCKING_STATUSES.has(held.status)
        ? incoming.status
        : held.status,
  };
}

const toDate = (iso: string | null) => (iso === null ? null : new Date(iso));

export class LedgerPlayEligibilityService implements Required<PlayEligibilityPort> {
  constructor(private readonly drizzle: DrizzleService) {}

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

  async set(input: LedgerV1SetPlayEligibilityArgs): Promise<void> {
    const args = LedgerV1SetPlayEligibilityArgsSchema.parse(input);
    const incoming: PlayEligibilityState = {
      rgBlocked: args.rgBlocked,
      rgBlockedUntil: toDate(args.rgBlockedUntil),
      isActive: args.isActive,
      banned: args.banned,
      banExpires: toDate(args.banExpires),
      status: args.status,
    };
    await this.drizzle.db.transaction((tx) =>
      withAdvisoryXactLock(tx, userLockKey(args.userId), async () => {
        const [held] = await tx
          .select()
          .from(ledgerPlayEligibility)
          .where(eq(ledgerPlayEligibility.userId, args.userId))
          .limit(1);
        if (held && held.version > args.version) {
          return;
        }
        const next = args.mode === 'restrict' && held ? stricterOf(held, incoming) : incoming;
        const row = { ...next, version: args.version, updatedAt: new Date() };
        await tx
          .insert(ledgerPlayEligibility)
          .values({ userId: args.userId, ...row })
          // The backfill writes without the per-user lock: never step back over what it wrote.
          .onConflictDoUpdate({
            target: ledgerPlayEligibility.userId,
            set: row,
            setWhere: sql`${ledgerPlayEligibility.version} <= excluded.version`,
          });
      }),
    );
  }
}

/**
 * Projects every user into `ledger_play_eligibility` and returns how many rows it wrote. Reads
 * the identity tables on the shared database. A row at the same version is rewritten only when
 * it differs, which heals a write that skipped the publisher; an older one is always replaced.
 */
export async function backfillLedgerPlayEligibility(db: DrizzleDb | DrizzleTx): Promise<number> {
  const result = await db
    .insert(ledgerPlayEligibility)
    .select(
      db
        .select({
          userId: user.id,
          rgBlocked: user.rgBlocked,
          rgBlockedUntil: user.rgBlockedUntil,
          isActive: user.isActive,
          banned: sql<boolean>`coalesce(${user.banned}, false)`.as('banned'),
          banExpires: user.banExpires,
          status: sql`${player.status}::text::ledger_player_status`.as('status'),
          version: user.playEligibilityVersion,
          updatedAt: sql`now()`.as('updated_at'),
        })
        .from(user)
        .leftJoin(player, eq(player.userId, user.id)),
    )
    .onConflictDoUpdate({
      target: ledgerPlayEligibility.userId,
      set: {
        rgBlocked: sql`excluded.rg_blocked`,
        rgBlockedUntil: sql`excluded.rg_blocked_until`,
        isActive: sql`excluded.is_active`,
        banned: sql`excluded.banned`,
        banExpires: sql`excluded.ban_expires`,
        status: sql`excluded.status`,
        version: sql`excluded.version`,
        updatedAt: sql`now()`,
      },
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

/** The boot run of the backfill: replicas booting together take turns, not race. */
export function backfillLedgerPlayEligibilityAtBoot(db: DrizzleDb): Promise<number> {
  return db.transaction((tx) =>
    withAdvisoryXactLock(tx, BACKFILL_LOCK_KEY, () => backfillLedgerPlayEligibility(tx)),
  );
}

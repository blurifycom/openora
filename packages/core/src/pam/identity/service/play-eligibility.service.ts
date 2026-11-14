import {
  DrizzleService,
  type DrizzleDb,
  type DrizzleTx,
  type EventBus,
} from '@openora/core/server';
import { eq, gt, sql } from 'drizzle-orm';
import {
  playRefusalOf,
  type PlayEligibilityPort,
  type PlayEligibilityProjectionPort,
  type PlayEligibilitySnapshot,
  type PlayRefusal,
  type User,
} from '@openora/core/contracts';
import { player } from '@openora/core/pam/schema/profile';
import { user } from '../schema/index.js';
import { isRgBlocked } from './rg-guard.service.js';

export class PlayEligibilityService implements PlayEligibilityPort {
  constructor(private readonly drizzle: DrizzleService) {}

  async isRestricted(userId: User['id'], tx?: unknown): Promise<boolean> {
    const db = (tx as DrizzleDb | undefined) ?? this.drizzle.db;
    const query = db
      .select({ rgBlocked: user.rgBlocked, rgBlockedUntil: user.rgBlockedUntil })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    const [row] = tx ? await query.for('share') : await query;
    if (!row) {
      return true;
    }
    return isRgBlocked(row);
  }

  // Locks the player row before the user row: a status writer holds the player row while it
  // publishes, which takes the user row, so the other order could deadlock with it.
  async checkPlay(userId: User['id'], tx?: unknown): Promise<PlayRefusal | null> {
    const db = (tx as DrizzleDb | undefined) ?? this.drizzle.db;
    const profileQuery = db
      .select({ status: player.status })
      .from(player)
      .where(eq(player.userId, userId))
      .limit(1);
    const [profile] = tx ? await profileQuery.for('share') : await profileQuery;
    const accountQuery = db
      .select({
        rgBlocked: user.rgBlocked,
        rgBlockedUntil: user.rgBlockedUntil,
        isActive: user.isActive,
        banned: user.banned,
        banExpires: user.banExpires,
      })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    const [account] = tx ? await accountQuery.for('share') : await accountQuery;
    if (!account) {
      return 'account_inactive';
    }
    return playRefusalOf({
      ...account,
      banned: account.banned === true,
      status: profile?.status ?? null,
    });
  }
}

type ProjectedState = {
  rgBlocked: boolean;
  rgBlockedUntil: Date | null;
  isActive: boolean;
  banned: boolean | null;
  banExpires: Date | null;
  status: PlayEligibilitySnapshot['status'];
  version: number;
};

function snapshotOf(userId: User['id'], state: ProjectedState): PlayEligibilitySnapshot {
  return {
    ...state,
    userId,
    banned: state.banned === true,
    rgBlockedUntil: state.rgBlockedUntil?.toISOString() ?? null,
    banExpires: state.banExpires?.toISOString() ?? null,
  };
}

/**
 * Writes a user's play eligibility to the ledger, the only place a stake is checked. Every
 * writer of an input (the RG block, `isActive`, the player status) calls `publish` in its own
 * transaction, after its change, so the ledger's row commits or rolls back with it.
 */
export class PlayEligibilityPublisher {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
    /** Resolved per call: wallet loads after identity, and a split may run identity alone. */
    private readonly projection: () => PlayEligibilityProjectionPort | undefined,
  ) {}

  /**
   * Bumps the user's version, which locks the row so publishes for one user run one at a time,
   * then writes the ledger's row on `tx`. The outbox event carries the same snapshot to a
   * process without the projection, and repairs one that lost it.
   */
  async publish(tx: DrizzleTx, userId: User['id']): Promise<void> {
    const [account] = await tx
      .update(user)
      .set({ playEligibilityVersion: sql`${user.playEligibilityVersion} + 1` })
      .where(eq(user.id, userId))
      .returning({
        rgBlocked: user.rgBlocked,
        rgBlockedUntil: user.rgBlockedUntil,
        isActive: user.isActive,
        banned: user.banned,
        banExpires: user.banExpires,
        version: user.playEligibilityVersion,
      });
    if (!account) {
      return;
    }
    const [profile] = await tx
      .select({ status: player.status })
      .from(player)
      .where(eq(player.userId, userId))
      .limit(1);
    const snapshot = snapshotOf(userId, { ...account, status: profile?.status ?? null });
    await this.projection()?.write(snapshot, tx);
    await this.events.emitInTransaction(tx, 'identity.play_eligibility.changed', snapshot);
  }

  /** `publish` in a transaction of its own, for a writer that changed nothing it must roll back. */
  sync(userId: User['id']): Promise<void> {
    return this.drizzle.db.transaction((tx) => this.publish(tx, userId));
  }
}

/**
 * Hands every user's committed play eligibility to the ledger in keyset batches, and returns
 * how many rows the ledger wrote. Heals a user registered by a replica that predates the
 * publisher, or a direct write that skipped it. Locks nothing on this side; the ledger rewrites
 * only rows that are missing or behind. An aborted `signal` stops it between batches.
 */
export async function backfillPlayEligibility(
  db: DrizzleDb,
  projection: PlayEligibilityProjectionPort,
  { batchSize = 500, signal }: { batchSize?: number; signal?: AbortSignal } = {},
): Promise<number> {
  let written = 0;
  let after: User['id'] | undefined;
  for (;;) {
    signal?.throwIfAborted();
    const rows = await db
      .select({
        userId: user.id,
        rgBlocked: user.rgBlocked,
        rgBlockedUntil: user.rgBlockedUntil,
        isActive: user.isActive,
        banned: user.banned,
        banExpires: user.banExpires,
        status: player.status,
        version: user.playEligibilityVersion,
      })
      .from(user)
      .leftJoin(player, eq(player.userId, user.id))
      .where(after === undefined ? undefined : gt(user.id, after))
      .orderBy(user.id)
      .limit(batchSize);
    if (rows.length === 0) {
      return written;
    }
    written += await projection.reconcile(rows.map((row) => snapshotOf(row.userId, row)));
    after = rows[rows.length - 1]?.userId;
  }
}

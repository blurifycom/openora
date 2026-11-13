import {
  createLogger,
  DrizzleService,
  type DrizzleDb,
  type DrizzleTx,
  type EventBus,
} from '@openora/core/server';
import { eq, sql } from 'drizzle-orm';
import {
  playRefusalOf,
  type LedgerApiV1,
  type PlayEligibilityPort,
  type PlayEligibilitySnapshot,
  type PlayRefusal,
  type User,
} from '@openora/core/contracts';
import { player } from '@openora/core/pam/schema/profile';
import { user } from '../schema/index.js';
import { isRgBlocked } from './rg-guard.service.js';

const log = createLogger('identity:play-eligibility');

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

/** What a writer runs once its transaction committed. */
export type PlayEligibilityPublication = { afterCommit(): Promise<void> };

/**
 * Pushes a user's play eligibility to the ledger, the only place a stake is checked. Every
 * writer of an input (the RG block, `isActive`, the player status) calls `publish` in its own
 * transaction, after its change.
 */
export class PlayEligibilityPublisher {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
    /** Resolved per call: wallet loads after identity, and without it nothing is staked. */
    private readonly ledger: () => LedgerApiV1 | undefined,
  ) {}

  /**
   * Bumps the user's version, which locks the row so publishes for one user run one at a time.
   * A state that refuses play goes to the ledger now, before the caller commits: a throw fails
   * the caller's change, so a restriction never commits while the ledger still lets the player
   * stake. The outbox event and `afterCommit` then carry the committed state, which is how a lift
   * reaches the ledger, only once it is real.
   */
  async publish(tx: DrizzleTx, userId: User['id']): Promise<PlayEligibilityPublication> {
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
      return { afterCommit: async () => undefined };
    }
    const [profile] = await tx
      .select({ status: player.status })
      .from(player)
      .where(eq(player.userId, userId))
      .limit(1);
    const state = { ...account, banned: account.banned === true, status: profile?.status ?? null };
    const snapshot: PlayEligibilitySnapshot = {
      ...state,
      userId,
      rgBlockedUntil: state.rgBlockedUntil?.toISOString() ?? null,
      banExpires: state.banExpires?.toISOString() ?? null,
    };
    const ledger = this.ledger();
    if (ledger && playRefusalOf(state) !== null) {
      await ledger.setPlayEligibility({ ...snapshot, mode: 'restrict' });
    }
    await this.events.emitInTransaction(tx, 'identity.play_eligibility.changed', snapshot);
    return {
      afterCommit: async () => {
        // The outbox event repairs a push that fails here; until then a lift waits, never a block.
        await ledger?.setPlayEligibility({ ...snapshot, mode: 'apply' }).catch((err: unknown) => {
          log.warn({ err, userId }, 'play eligibility push failed; the outbox event will retry');
        });
      },
    };
  }

  /** `publish` in a transaction of its own, for a writer that changed nothing it must roll back. */
  async sync(userId: User['id']): Promise<void> {
    const publication = await this.drizzle.db.transaction((tx) => this.publish(tx, userId));
    await publication.afterCommit();
  }
}

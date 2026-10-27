import { and, asc, eq, ilike, inArray, sql, type SQL } from 'drizzle-orm';
import {
  findOneOrThrow,
  likeContains,
  roles,
  type AdminCaller,
  type AdminGuard,
  type DrizzleService,
  type DrizzleTx,
  type EventBus,
} from '@openora/core/server';
import type {
  AccountManager,
  AccountManagerIneligibleReason,
  AuditWritePort,
  Player,
  PlayerAccountManagerReader,
  User,
} from '@openora/core/contracts';
import { player } from '@openora/core/pam/schema/profile';
import { user } from '@openora/core/pam/schema/identity';
import { PlayerNotFoundError } from './player.service.js';
import type { AccountManagerCandidate } from '../contract/index.js';

const PLAYER_VIEW = [{ resource: 'player', action: 'view' }] as const;
const CANDIDATE_BATCH_SIZE = 100;
const STAFF_ROLES = Object.keys(roles);

export class AccountManagerIneligibleError extends Error {
  readonly data: { reason: AccountManagerIneligibleReason };

  constructor(reason: AccountManagerIneligibleReason) {
    super(`The user cannot be an account manager: ${reason}`);
    this.name = 'AccountManagerIneligibleError';
    this.data = { reason };
  }
}

function accountIneligibility(account: {
  role: string;
  isActive: boolean;
}): AccountManagerIneligibleReason | null {
  if (account.role === 'player') {
    return 'not_eligible';
  }
  return account.isActive ? null : 'inactive';
}

type AccountManagerDeps = {
  drizzle: DrizzleService;
  events: EventBus;
  audit: AuditWritePort;
  adminGuard: AdminGuard;
};

export class AccountManagerService implements PlayerAccountManagerReader {
  constructor(private readonly deps: AccountManagerDeps) {}

  /**
   * Assigns, changes or, with null, removes the player's account manager. A new manager must be
   * active staff holding `player:view`; removing is always allowed. Setting the current value
   * again writes nothing, so it leaves no audit record and emits no event. The manager's account
   * is re-read under a share lock with the player row, so a deactivation racing the assignment
   * is refused instead of stored.
   */
  async set(
    playerId: Player['id'],
    accountManagerId: User['id'] | null,
    caller: AdminCaller,
  ): Promise<{ accountManager: AccountManager | null }> {
    // ponytail: the player:view grant is checked before the transaction, so a role revoked in
    // that gap still assigns; lock the grant rows inside it if that window ever matters.
    const holdsView = accountManagerId !== null && (await this.holdsPlayerView(accountManagerId));
    await this.deps.drizzle.db.transaction(async (tx) => {
      const locked = findOneOrThrow(
        await tx
          .select({ userId: player.userId, accountManagerId: player.accountManagerId })
          .from(player)
          .where(eq(player.id, playerId))
          .for('update'),
        new PlayerNotFoundError(playerId),
      );
      const nextId =
        accountManagerId === null
          ? null
          : await this.lockEligibleManager(tx, accountManagerId, holdsView);
      if (locked.accountManagerId === nextId) {
        return;
      }
      await tx.update(player).set({ accountManagerId: nextId }).where(eq(player.id, playerId));
      await this.deps.audit.recordInTransaction(tx, {
        actorType: 'admin',
        actorId: caller.userId,
        action: 'admin.player.account_manager_changed',
        resourceType: 'player',
        resourceId: playerId,
        before: { accountManagerId: locked.accountManagerId },
        after: { accountManagerId: nextId },
        ip: caller.ip,
        userAgent: caller.userAgent,
      });
      await this.deps.events.emitInTransaction(tx, 'player.account_manager.changed', {
        playerId,
        userId: locked.userId,
        previousAccountManagerId: locked.accountManagerId,
        accountManagerId: nextId,
        actorId: caller.userId,
      });
    });
    return { accountManager: await this.readManager(eq(player.id, playerId)) };
  }

  /**
   * Up to `limit` active staff holding `player:view` whose name contains `search`, ordered by
   * name. Staff are read in batches, each checked against its grants in one call, until `limit`
   * are found or none are left, so staff without the grant never crowd out eligible ones.
   */
  async candidates(search: string | undefined, limit: number) {
    const where = and(
      // Matches user_staff_name_idx's predicate, so the planner can scan that partial index.
      sql`${user.role} <> 'player'`,
      inArray(user.role, STAFF_ROLES),
      eq(user.isActive, true),
      search ? ilike(user.name, likeContains(search)) : undefined,
    );
    const eligible: AccountManagerCandidate[] = [];
    for (let offset = 0; eligible.length < limit; offset += CANDIDATE_BATCH_SIZE) {
      const batch = await this.deps.drizzle.db
        .select({ userId: user.id, name: user.name })
        .from(user)
        .where(where)
        .orderBy(asc(user.name), asc(user.id))
        .limit(CANDIDATE_BATCH_SIZE)
        .offset(offset);
      const granted = await this.deps.adminGuard.filterGrantedUsers(
        batch.map(({ userId }) => userId),
        PLAYER_VIEW,
      );
      eligible.push(...batch.filter(({ userId }) => granted.has(userId)));
      if (batch.length < CANDIDATE_BATCH_SIZE) {
        break;
      }
    }
    return eligible.slice(0, limit);
  }

  /**
   * Locks the manager's account against a concurrent deactivation and answers its id as the
   * database stores it, whatever letter case the caller sent; throws when it is ineligible.
   */
  private async lockEligibleManager(
    tx: DrizzleTx,
    userId: User['id'],
    holdsView: boolean,
  ): Promise<User['id']> {
    // A read lock on identity's row across the module boundary; it becomes a port call when
    // identity is extracted.
    const [account] = await tx
      .select({ id: user.id, role: user.role, isActive: user.isActive })
      .from(user)
      .where(eq(user.id, userId))
      .for('share');
    if (!account) {
      throw new AccountManagerIneligibleError('unknown');
    }
    const reason = accountIneligibility(account) ?? (holdsView ? null : 'not_eligible');
    if (reason) {
      throw new AccountManagerIneligibleError(reason);
    }
    return account.id;
  }

  async getByPlayerUserId(userId: User['id']): Promise<AccountManager | null> {
    return this.readManager(eq(player.userId, userId));
  }

  private async readManager(where: SQL): Promise<AccountManager | null> {
    const [row] = await this.deps.drizzle.db
      .select({ userId: user.id, name: user.name, isActive: user.isActive })
      .from(player)
      .innerJoin(user, eq(user.id, player.accountManagerId))
      .where(where)
      .limit(1);
    return row ?? null;
  }

  private async holdsPlayerView(userId: User['id']): Promise<boolean> {
    return (await this.deps.adminGuard.filterGranted(userId, PLAYER_VIEW)).length > 0;
  }
}

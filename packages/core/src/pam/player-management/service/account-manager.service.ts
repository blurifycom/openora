import { and, asc, eq, ilike, ne, or } from 'drizzle-orm';
import {
  findOneOrThrow,
  likeContains,
  mapConcurrent,
  type AdminCaller,
  type AdminGuard,
  type DrizzleService,
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

const PLAYER_VIEW = [{ resource: 'player', action: 'view' }] as const;
const CANDIDATE_BATCH_SIZE = 100;
const GRANT_CHECK_CONCURRENCY = 10;

export class AccountManagerIneligibleError extends Error {
  readonly data: { reason: AccountManagerIneligibleReason };

  constructor(reason: AccountManagerIneligibleReason) {
    super(`The user cannot be an account manager: ${reason}`);
    this.name = 'AccountManagerIneligibleError';
    this.data = { reason };
  }
}

const managerColumns = {
  userId: user.id,
  name: user.name,
  email: user.email,
  isActive: user.isActive,
};

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
   * again writes nothing, so it leaves no audit record and emits no event.
   */
  async set(
    playerId: Player['id'],
    accountManagerId: User['id'] | null,
    caller: AdminCaller,
  ): Promise<{ accountManager: AccountManager | null }> {
    if (accountManagerId !== null) {
      const reason = await this.ineligibility(accountManagerId);
      if (reason) {
        throw new AccountManagerIneligibleError(reason);
      }
    }
    await this.deps.drizzle.db.transaction(async (tx) => {
      const locked = findOneOrThrow(
        await tx
          .select({ userId: player.userId, accountManagerId: player.accountManagerId })
          .from(player)
          .where(eq(player.id, playerId))
          .for('update'),
        new PlayerNotFoundError(playerId),
      );
      if (locked.accountManagerId === accountManagerId) {
        return;
      }
      await tx.update(player).set({ accountManagerId }).where(eq(player.id, playerId));
      await this.deps.audit.recordInTransaction(tx, {
        actorType: 'admin',
        actorId: caller.userId,
        action: 'admin.player.account_manager_changed',
        resourceType: 'player',
        resourceId: playerId,
        before: { accountManagerId: locked.accountManagerId },
        after: { accountManagerId },
        ip: caller.ip,
        userAgent: caller.userAgent,
      });
      await this.deps.events.emitInTransaction(tx, 'player.account_manager.changed', {
        playerId,
        userId: locked.userId,
        previousAccountManagerId: locked.accountManagerId,
        accountManagerId,
        actorId: caller.userId,
      });
    });
    return { accountManager: await this.findManager(playerId) };
  }

  /**
   * Up to `limit` active staff holding `player:view` whose name or email contains `search`,
   * ordered by name. Staff are read in batches and checked against their grants until `limit`
   * are found or none are left, so staff without the grant never crowd out eligible ones.
   */
  async candidates(search: string | undefined, limit: number) {
    const where = and(
      ne(user.role, 'player'),
      eq(user.isActive, true),
      search
        ? or(ilike(user.name, likeContains(search)), ilike(user.email, likeContains(search)))
        : undefined,
    );
    const eligible: { userId: User['id']; name: string; email: string }[] = [];
    for (let offset = 0; eligible.length < limit; offset += CANDIDATE_BATCH_SIZE) {
      const batch = await this.deps.drizzle.db
        .select({ userId: user.id, name: user.name, email: user.email })
        .from(user)
        .where(where)
        .orderBy(asc(user.name), asc(user.id))
        .limit(CANDIDATE_BATCH_SIZE)
        .offset(offset);
      const granted = await mapConcurrent(batch, GRANT_CHECK_CONCURRENCY, async ({ userId }) =>
        this.holdsPlayerView(userId),
      );
      eligible.push(...batch.filter((_, index) => granted[index]));
      if (batch.length < CANDIDATE_BATCH_SIZE) {
        break;
      }
    }
    return eligible.slice(0, limit);
  }

  async getByPlayerUserId(userId: User['id']): Promise<AccountManager | null> {
    const [row] = await this.deps.drizzle.db
      .select(managerColumns)
      .from(player)
      .innerJoin(user, eq(user.id, player.accountManagerId))
      .where(eq(player.userId, userId))
      .limit(1);
    return row ?? null;
  }

  private async findManager(playerId: Player['id']): Promise<AccountManager | null> {
    const [row] = await this.deps.drizzle.db
      .select(managerColumns)
      .from(player)
      .innerJoin(user, eq(user.id, player.accountManagerId))
      .where(eq(player.id, playerId))
      .limit(1);
    return row ?? null;
  }

  private async ineligibility(userId: User['id']): Promise<AccountManagerIneligibleReason | null> {
    const [account] = await this.deps.drizzle.db
      .select({ role: user.role, isActive: user.isActive })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    if (!account) {
      return 'unknown';
    }
    if (account.role === 'player') {
      return 'not_eligible';
    }
    if (!account.isActive) {
      return 'inactive';
    }
    return (await this.holdsPlayerView(userId)) ? null : 'not_eligible';
  }

  private async holdsPlayerView(userId: User['id']): Promise<boolean> {
    return (await this.deps.adminGuard.filterGranted(userId, PLAYER_VIEW)).length > 0;
  }
}

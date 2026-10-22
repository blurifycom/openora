import { asc, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  createDomainError,
  createLogger,
  makeNotFoundError,
  type DrizzleService,
} from '@openora/core/server';
import {
  SupportChatCustomerTokenSchema,
  SupportChatProviderError,
  normalizeKycStatus,
  type AuditWritePort,
  type ClientMeta,
  type IdentityReader,
  type PlayerStatus,
  type RgExclusionReader,
  type SupportChatCustomerToken,
  type SupportChatProvider,
  type SupportCustomerContext,
  type WalletReader,
} from '@openora/core/contracts';
import { user, type User } from '@openora/core/pam/schema/identity';
import { player, type Player } from '@openora/core/pam/schema/profile';
import { promoPlayerRank, promoRankTier } from '@openora/core/promo/schema/gamification';
import { supportChatCustomer, type SupportChatCustomer } from '../schema/index.js';

const logger = createLogger('support-chat');

const lowestTier = alias(promoRankTier, 'lowest_tier');

export const SupportChatPlayerNotFoundError = makeNotFoundError('Player');

export const SupportChatNotConfiguredError = createDomainError<[]>(
  'SupportChatNotConfiguredError',
  () => 'Support chat is not configured',
);

export const SupportChatUnavailableError = createDomainError<[]>(
  'SupportChatUnavailableError',
  () => 'Support chat is unavailable',
);

// Its message reaches the player, so the detail is logged where it is thrown instead.
export const SupportChatLinkMissingError = createDomainError<[]>(
  'SupportChatLinkMissingError',
  () => 'Support chat could not be opened',
);

export type SupportCustomerReading = Omit<SupportCustomerContext, 'accountStatus' | 'syncedAt'> & {
  playerStatus: PlayerStatus;
};

// A self-exclusion does not move `player.status`, so it is folded in here; a suspended or
// closed account keeps its own status.
function accountStatusOf({ playerStatus, isSelfExcluded }: SupportCustomerReading): PlayerStatus {
  if (playerStatus === 'suspended' || playerStatus === 'closed') {
    return playerStatus;
  }
  return isSelfExcluded ? 'self_excluded' : playerStatus;
}

export function toSupportCustomerContext(
  reading: SupportCustomerReading,
  now: Date,
): SupportCustomerContext {
  return {
    playerId: reading.playerId,
    userId: reading.userId,
    username: reading.username,
    email: reading.email,
    accountStatus: accountStatusOf(reading),
    isSelfExcluded: reading.isSelfExcluded,
    isCoolingOff: reading.isCoolingOff,
    kycStatus: normalizeKycStatus(reading.kycStatus),
    rankName: reading.rankName,
    activeCurrency: reading.activeCurrency,
    syncedAt: now.toISOString(),
  };
}

// An adapter may throw anything, such as an HTTP client error holding the vendor API key or the
// player's data. Only its class name survives, so nothing of it reaches a log, the error reporter
// or the job queue.
const asProviderError = (err: unknown): SupportChatProviderError =>
  err instanceof SupportChatProviderError
    ? err
    : new SupportChatProviderError(`adapter threw ${err instanceof Error ? err.name : typeof err}`);

/** Extra writes a sync makes when the context moved under it, before it gives up to the job's retry. */
export const MAX_EXTRA_SYNC_ROUNDS = 2;

export class SupportContextNotSettledError extends Error {
  constructor() {
    super(`support context still changing after ${MAX_EXTRA_SYNC_ROUNDS} extra sync rounds`);
    this.name = 'SupportContextNotSettledError';
  }
}

// Both sides come from `toSupportCustomerContext`, so their keys are in the same order.
const withoutSyncedAt = (context: SupportCustomerContext) =>
  JSON.stringify({ ...context, syncedAt: null });

/**
 * Writes `first`, then re-reads and writes again while the context moved, so the last write any
 * sync makes is checked against the database as it stands after that write. Two syncs racing
 * each other therefore converge on the latest state whichever write lands last. Stops quietly
 * when `read` finds nothing; throws once the cap is spent so the job retries later.
 */
export async function syncUntilSettled(
  first: SupportCustomerContext,
  read: () => Promise<SupportCustomerContext | null>,
  write: (context: SupportCustomerContext) => Promise<void>,
): Promise<void> {
  let context = first;
  for (let round = 0; ; round++) {
    await write(context);
    const current = await read();
    if (!current || withoutSyncedAt(current) === withoutSyncedAt(context)) {
      return;
    }
    if (round === MAX_EXTRA_SYNC_ROUNDS) {
      throw new SupportContextNotSettledError();
    }
    context = current;
  }
}

type SupportChatDeps = {
  drizzle: DrizzleService;
  audit: AuditWritePort;
  identityReader: IdentityReader;
  walletReader: WalletReader;
  rgExclusionReader: RgExclusionReader;
  provider: SupportChatProvider;
  scheduleSync: (userId: User['id']) => Promise<void>;
};

export class SupportChatService {
  constructor(private readonly deps: SupportChatDeps) {}

  /**
   * A token for the caller's own vendor customer, created and linked on the first call. The
   * context sync is enqueued, never awaited: vendor writes stay off the request path.
   */
  async openSession(userId: User['id'], clientMeta: ClientMeta): Promise<SupportChatCustomerToken> {
    const playerId = await this.deps.identityReader.getPlayerIdByUserId(userId);
    if (!playerId) {
      throw new SupportChatPlayerNotFoundError(userId);
    }
    const customerId = await this.findCustomerId(playerId);
    const token = customerId
      ? await this.issueToken(playerId, customerId)
      : await this.linkNewCustomer(userId, playerId, clientMeta);
    await this.deps
      .scheduleSync(userId)
      .catch((err: unknown) =>
        logger.error({ err, userId }, 'support-chat sync not enqueued on session open'),
      );
    return token;
  }

  /** Writes the current context onto the player's vendor customer; a player who never opened the chat is skipped. */
  async syncCustomer(userId: User['id']): Promise<void> {
    const linked = await this.readLinkedContext(userId);
    if (!linked) {
      return;
    }
    await syncUntilSettled(
      linked.context,
      async () => (await this.readLinkedContext(userId))?.context ?? null,
      (context) =>
        this.deps.provider.syncCustomer(linked.customerId, context).catch((err: unknown) => {
          throw asProviderError(err);
        }),
    );
  }

  /** Whether the player ever opened the chat: only then is there a vendor customer to refresh. */
  async hasLinkedCustomer(userId: User['id']): Promise<boolean> {
    const [row] = await this.deps.drizzle.db
      .select({ playerId: supportChatCustomer.playerId })
      .from(supportChatCustomer)
      .innerJoin(player, eq(player.id, supportChatCustomer.playerId))
      .where(eq(player.userId, userId))
      .limit(1);
    return row !== undefined;
  }

  /** The linked vendor customer and the context read now, in one query; null when not linked. */
  private async readLinkedContext(userId: User['id']): Promise<{
    customerId: SupportChatCustomer['providerCustomerId'];
    context: SupportCustomerContext;
  } | null> {
    const [row] = await this.deps.drizzle.db
      .select({
        customerId: supportChatCustomer.providerCustomerId,
        playerId: player.id,
        userId: player.userId,
        username: user.username,
        email: user.email,
        playerStatus: player.status,
        kycStatus: player.kycStatus,
        // A player with no tier yet sits on the ladder's bottom rung, as the rank read shows it.
        rankName: sql<string | null>`coalesce(${promoRankTier.name}, (${this.deps.drizzle.db
          .select({ name: lowestTier.name })
          .from(lowestTier)
          .orderBy(asc(lowestTier.position))
          .limit(1)}))`,
      })
      .from(supportChatCustomer)
      .innerJoin(player, eq(player.id, supportChatCustomer.playerId))
      .innerJoin(user, eq(user.id, player.userId))
      .leftJoin(promoPlayerRank, eq(promoPlayerRank.userId, player.userId))
      .leftJoin(promoRankTier, eq(promoRankTier.id, promoPlayerRank.tierId))
      .where(eq(player.userId, userId))
      .limit(1);
    if (!row) {
      return null;
    }
    const { customerId, ...reading } = row;
    const [exclusions, { activeCurrency }] = await Promise.all([
      this.deps.rgExclusionReader.getExclusionState(userId),
      this.deps.walletReader.getBalances(userId),
    ]);
    return {
      customerId,
      context: toSupportCustomerContext({ ...reading, ...exclusions, activeCurrency }, new Date()),
    };
  }

  private async findCustomerId(
    playerId: Player['id'],
  ): Promise<SupportChatCustomer['providerCustomerId'] | null> {
    const [row] = await this.deps.drizzle.db
      .select({ providerCustomerId: supportChatCustomer.providerCustomerId })
      .from(supportChatCustomer)
      .where(eq(supportChatCustomer.playerId, playerId))
      .limit(1);
    return row?.providerCustomerId ?? null;
  }

  /**
   * Creates a vendor customer and links it. A concurrent first open that linked first wins: this
   * call then answers for the winner's customer and leaves its own vendor customer unused. A
   * vendor customer already linked to another player fails the insert rather than merging them.
   */
  private async linkNewCustomer(
    userId: User['id'],
    playerId: Player['id'],
    clientMeta: ClientMeta,
  ): Promise<SupportChatCustomerToken> {
    const created = await this.issueToken(playerId);
    const inserted = await this.deps.drizzle.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(supportChatCustomer)
        .values({ playerId, providerCustomerId: created.customerId })
        .onConflictDoNothing({ target: supportChatCustomer.playerId })
        .returning({ playerId: supportChatCustomer.playerId });
      if (row) {
        await this.deps.audit.recordInTransaction(tx, {
          actorType: 'player',
          actorId: userId,
          action: 'support_chat.customer.linked',
          resourceType: 'support_chat_customer',
          resourceId: playerId,
          after: { providerCustomerId: created.customerId },
          ...clientMeta,
        });
      }
      return row !== undefined;
    });
    if (inserted) {
      return created;
    }
    const linked = await this.findCustomerId(playerId);
    if (!linked) {
      logger.error({ playerId }, 'support-chat link missing after a conflicting insert');
      throw new SupportChatLinkMissingError();
    }
    return linked === created.customerId ? created : this.issueToken(playerId, linked);
  }

  /** The vendor's reason goes to the log only; the player gets the generic unavailable error. */
  private async issueToken(
    playerId: Player['id'],
    customerId?: SupportChatCustomer['providerCustomerId'],
  ): Promise<SupportChatCustomerToken> {
    const refuse = (reason: string) => {
      logger.warn({ playerId, reason }, 'support-chat customer token not issued');
      return new SupportChatUnavailableError();
    };
    let answer: unknown;
    try {
      answer = await this.deps.provider.issueCustomerToken(customerId ? { customerId } : {});
    } catch (err) {
      throw refuse(asProviderError(err).reason);
    }
    const parsed = SupportChatCustomerTokenSchema.safeParse(answer);
    if (!parsed.success) {
      throw refuse('malformed token answer');
    }
    if (customerId && parsed.data.customerId !== customerId) {
      throw refuse('token answered for another customer');
    }
    return parsed.data;
  }
}

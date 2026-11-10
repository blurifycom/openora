import { asc, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  createDomainError,
  createLogger,
  loggableError,
  makeNotFoundError,
  type DrizzleService,
  type EventBus,
} from '@openora/core/server';
import {
  SupportChatCustomerTokenSchema,
  SupportTicketCreatedSchema,
  normalizeKycStatus,
  type AuditWritePort,
  type ClientMeta,
  type IdentityReader,
  type PlayerAccountManagerReader,
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
import { reasonOf, type ProviderFailureReason } from './provider-reason.service.js';

const logger = createLogger('support-chat');

const lowestTier = alias(promoRankTier, 'lowest_tier');

export const SupportChatPlayerNotFoundError = makeNotFoundError('Player');

export const SupportChatNotConfiguredError = createDomainError<[]>(
  'SupportChatNotConfiguredError',
  () => 'Support chat is not configured',
  { reason: 'not_configured' },
);

export const SupportChatUnavailableError = createDomainError<[]>(
  'SupportChatUnavailableError',
  () => 'Support chat is unavailable',
  { reason: 'unavailable' },
);

// Its message reaches the player, so the detail is logged where it is thrown instead.
export const SupportChatLinkMissingError = createDomainError<[]>(
  'SupportChatLinkMissingError',
  () => 'Support chat could not be opened',
);

// A unique email is not a proven one: an account can be registered on someone else's
// not-yet-registered address, and the vendor files the ticket under whoever owns that email.
export const SupportTicketEmailNotVerifiedError = createDomainError<[]>(
  'SupportTicketEmailNotVerifiedError',
  () => 'Verify your email address before writing to support',
  { reason: 'email_not_verified' },
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
    accountManagerName: reading.accountManagerName,
    activeCurrency: reading.activeCurrency,
    syncedAt: now.toISOString(),
  };
}

// What the job queue and the error reporter see of a failed vendor write: the listed code only,
// never the adapter's error or its `cause`.
export const SupportChatSyncFailedError = createDomainError<[reason: ProviderFailureReason]>(
  'SupportChatSyncFailedError',
  (reason) => `support-chat provider failed: ${reason}`,
);

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

/**
 * Whether the player ever opened the chat: only then is there a vendor customer to refresh. Read
 * from the table, so a process without a provider bound still sees a link another process made.
 */
export async function hasLinkedCustomer(
  drizzle: DrizzleService,
  userId: User['id'],
): Promise<boolean> {
  const [row] = await drizzle.db
    .select({ playerId: supportChatCustomer.playerId })
    .from(supportChatCustomer)
    .innerJoin(player, eq(player.id, supportChatCustomer.playerId))
    .where(eq(player.userId, userId))
    .limit(1);
  return row !== undefined;
}

type SupportChatDeps = {
  drizzle: DrizzleService;
  audit: AuditWritePort;
  events: EventBus;
  identityReader: IdentityReader;
  walletReader: WalletReader;
  rgExclusionReader: RgExclusionReader;
  accountManagerReader: PlayerAccountManagerReader | null;
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
    if (!customerId) {
      // The first sync rides on the link's own event, so a queue outage cannot drop it.
      return this.linkNewCustomer(userId, playerId, clientMeta);
    }
    const token = await this.issueToken(playerId, customerId);
    await this.deps
      .scheduleSync(userId)
      .catch((err: unknown) =>
        logger.error({ err, userId }, 'support-chat sync not enqueued on session open'),
      );
    return token;
  }

  /**
   * Hands the vendor one ticket from the caller's own player, under the name, email and language
   * read from the account now. Not idempotent: a double submit is two tickets.
   */
  async createTicket(userId: User['id'], message: string, clientMeta: ClientMeta): Promise<void> {
    if (!this.deps.provider.createTicket) {
      throw new SupportChatNotConfiguredError();
    }
    const [account] = await this.deps.drizzle.db
      .select({
        playerId: player.id,
        username: user.username,
        email: user.email,
        language: user.language,
        emailVerified: user.emailVerified,
      })
      .from(player)
      .innerJoin(user, eq(user.id, player.userId))
      .where(eq(player.userId, userId))
      .limit(1);
    if (!account) {
      throw new SupportChatPlayerNotFoundError(userId);
    }
    const { playerId } = account;
    if (!account.emailVerified) {
      throw new SupportTicketEmailNotVerifiedError();
    }
    let answer: unknown;
    try {
      answer = await this.deps.provider.createTicket({
        requester: { name: account.username, email: account.email },
        language: account.language,
        message,
      });
    } catch (err) {
      logger.warn({ playerId, reason: reasonOf(err) }, 'support ticket not created');
      throw new SupportChatUnavailableError();
    }
    // The ticket exists at the vendor by now, so neither a malformed answer nor a failed audit
    // write may answer the player as if it did not: a retry would file it twice.
    const ticketId = this.ticketIdOf(playerId, answer);
    await this.deps.audit
      .record({
        actorType: 'player',
        actorId: userId,
        action: 'support_chat.ticket.created',
        resourceType: 'player',
        resourceId: playerId,
        after: { ticketId },
        ...clientMeta,
      })
      .catch((err: unknown) =>
        logger.error(
          { err: loggableError(err), playerId },
          'support ticket created but not audited',
        ),
      );
  }

  /**
   * The vendor's ticket id, or null when its answer is off the schema. Only the parsed id leaves
   * here: the raw answer may hold the requester's email or the message, and the audit row it
   * would land in is append-only.
   */
  private ticketIdOf(playerId: Player['id'], answer: unknown): string | null {
    // safeParse rethrows what a getter on the answer throws, which is the adapter's text too.
    try {
      const parsed = SupportTicketCreatedSchema.safeParse(answer);
      if (parsed.success) {
        return parsed.data.ticketId;
      }
    } catch {
      // Logged below as malformed, like an answer that fails the schema.
    }
    logger.warn({ playerId, reason: 'malformed ticket answer' }, 'support ticket id not recorded');
    return null;
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
      // Awaited inside the try, so an adapter that throws before handing back a promise is
      // wrapped too.
      async (context) => {
        try {
          await this.deps.provider.syncCustomer(linked.customerId, context);
        } catch (err) {
          throw new SupportChatSyncFailedError(reasonOf(err));
        }
      },
    );
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
    const [exclusions, { activeCurrency }, accountManager] = await Promise.all([
      this.deps.rgExclusionReader.getExclusionState(userId),
      this.deps.walletReader.getBalances(userId),
      this.deps.accountManagerReader?.getByPlayerUserId(userId) ?? null,
    ]);
    return {
      customerId,
      context: toSupportCustomerContext(
        {
          ...reading,
          ...exclusions,
          activeCurrency,
          accountManagerName: accountManager?.name ?? null,
        },
        new Date(),
      ),
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
        await this.deps.events.emitInTransaction(tx, 'support_chat.customer.linked', {
          userId,
          playerId,
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
    const refuse = (
      reason:
        | ProviderFailureReason
        | 'malformed token answer'
        | 'token answered for another customer',
    ) => {
      logger.warn({ playerId, reason }, 'support-chat customer token not issued');
      return new SupportChatUnavailableError();
    };
    let answer: unknown;
    try {
      answer = await this.deps.provider.issueCustomerToken(customerId ? { customerId } : {});
    } catch (err) {
      throw refuse(reasonOf(err));
    }
    // safeParse rethrows what a getter on the answer throws, which is the adapter's text too.
    let parsed: ReturnType<typeof SupportChatCustomerTokenSchema.safeParse>;
    try {
      parsed = SupportChatCustomerTokenSchema.safeParse(answer);
    } catch {
      throw refuse('malformed token answer');
    }
    if (!parsed.success) {
      throw refuse('malformed token answer');
    }
    if (customerId && parsed.data.customerId !== customerId) {
      throw refuse('token answered for another customer');
    }
    return parsed.data;
  }
}

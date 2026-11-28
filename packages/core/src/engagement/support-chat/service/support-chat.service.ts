import { eq } from 'drizzle-orm';
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
  type SupportTicketRequest,
  type PlayerRankReader,
  type WalletReader,
} from '@openora/core/contracts';
import { user, type User } from '@openora/core/pam/schema/identity';
import { player, type Player } from '@openora/core/pam/schema/profile';
import { supportChatCustomer, type SupportChatCustomer } from '../schema/index.js';
import { reasonOf, type ProviderFailureReason } from './provider-reason.service.js';

const logger = createLogger('support-chat');

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

export const SupportChatLinkMissingError = createDomainError<[]>(
  'SupportChatLinkMissingError',
  () => 'Support chat could not be opened',
);

export const SupportTicketEmailNotVerifiedError = createDomainError<[]>(
  'SupportTicketEmailNotVerifiedError',
  () => 'Verify your email address before writing to support',
  { reason: 'email_not_verified' },
);

type SupportCustomerReading = Omit<SupportCustomerContext, 'accountStatus' | 'syncedAt'> & {
  playerStatus: PlayerStatus;
};

export function accountStatusOf({
  playerStatus,
  isSelfExcluded,
}: SupportCustomerReading): PlayerStatus {
  if (playerStatus === 'suspended' || playerStatus === 'closed') {
    return playerStatus;
  }
  return isSelfExcluded ? 'self_excluded' : playerStatus;
}

function toSupportCustomerContext(
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

export const SupportChatSyncFailedError = createDomainError<[reason: ProviderFailureReason]>(
  'SupportChatSyncFailedError',
  (reason) => `support-chat provider failed: ${reason}`,
);

const MAX_EXTRA_SYNC_ROUNDS = 2;

class SupportContextNotSettledError extends Error {
  constructor() {
    super(`support context still changing after ${MAX_EXTRA_SYNC_ROUNDS} extra sync rounds`);
    this.name = 'SupportContextNotSettledError';
  }
}

const withoutSyncedAt = (context: SupportCustomerContext) =>
  JSON.stringify({ ...context, syncedAt: null });

async function syncUntilSettled(
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
  rankReader: PlayerRankReader;
  rgExclusionReader: RgExclusionReader;
  accountManagerReader: PlayerAccountManagerReader | null;
  provider: SupportChatProvider;
  scheduleSync: (userId: User['id']) => Promise<void>;
};

export class SupportChatService {
  constructor(private readonly deps: SupportChatDeps) {}

  async openSession(userId: User['id'], clientMeta: ClientMeta): Promise<SupportChatCustomerToken> {
    const playerId = await this.deps.identityReader.getPlayerIdByUserId(userId);
    if (!playerId) {
      throw new SupportChatPlayerNotFoundError(userId);
    }
    const customerId = await this.findCustomerId(playerId);
    if (!customerId) {
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

  async createTicket(
    userId: User['id'],
    { subject, message }: Pick<SupportTicketRequest, 'subject' | 'message'>,
    clientMeta: ClientMeta,
  ): Promise<void> {
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
        subject,
        message,
      });
    } catch (err) {
      logger.warn({ playerId, reason: reasonOf(err) }, 'support ticket not created');
      throw new SupportChatUnavailableError();
    }
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

  private ticketIdOf(playerId: Player['id'], answer: unknown): string | null {
    const ticketId = ticketIdFromAnswer(answer);
    if (ticketId !== null) {
      return ticketId;
    }
    logger.warn({ playerId, reason: 'malformed ticket answer' }, 'support ticket id not recorded');
    return null;
  }

  async syncCustomer(userId: User['id']): Promise<void> {
    const linked = await this.readLinkedContext(userId);
    if (!linked) {
      return;
    }
    await syncUntilSettled(
      linked.context,
      async () => (await this.readLinkedContext(userId))?.context ?? null,
      async (context) => {
        try {
          await this.deps.provider.syncCustomer(linked.customerId, context);
        } catch (err) {
          throw new SupportChatSyncFailedError(reasonOf(err));
        }
      },
    );
  }

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
      })
      .from(supportChatCustomer)
      .innerJoin(player, eq(player.id, supportChatCustomer.playerId))
      .innerJoin(user, eq(user.id, player.userId))
      .where(eq(player.userId, userId))
      .limit(1);
    if (!row) {
      return null;
    }
    const { customerId, ...reading } = row;
    const [exclusions, { activeCurrency }, accountManager, rankName] = await Promise.all([
      this.deps.rgExclusionReader.getExclusionState(userId),
      this.deps.walletReader.getBalances(userId),
      this.deps.accountManagerReader?.getByPlayerUserId(userId) ?? null,
      this.deps.rankReader.getRankName(userId),
    ]);
    return {
      customerId,
      context: toSupportCustomerContext(
        {
          ...reading,
          ...exclusions,
          rankName,
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

export function ticketIdFromAnswer(answer: unknown): string | null {
  try {
    const parsed = SupportTicketCreatedSchema.safeParse(answer);
    return parsed.success ? parsed.data.ticketId : null;
  } catch {
    return null;
  }
}

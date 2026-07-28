import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  DrizzleService,
  makeNotFoundError,
  makeConflictError,
  mapConcurrent,
  moneyToNumber,
  findOneOrThrow,
  serializeRow,
  type EventBus,
} from '@openora/core/server';
import type {
  Uuid,
  ChatSystemMessage,
  ChatSystemWriter,
  ChatBlockWriter,
  WalletCommands,
  AdminUserDirectory,
  AuditWritePort,
  RealtimeTransport,
} from '@openora/core/contracts';
import { chatChannel } from '@openora/core/contracts';
import type {
  ChatCommandDescriptor,
  ChatCommandType,
  CommandConfig,
  GiftState,
  ClaimGiftOutput,
} from '../contract/index.js';
import { ChatCommandTypeSchema } from '../contract/index.js';
import { chatCommandConfig, chatGift } from '../schema/index.js';

export const CommandDisabledError = makeNotFoundError('ChatCommand');
export const NoOnlineUsersError = makeConflictError(
  'NoOnlineUsers',
  'No other users are online in this room',
);
export const InsufficientBalanceError = makeConflictError(
  'InsufficientBalance',
  'Not enough balance',
);
export const ExceedsLimitError = makeConflictError(
  'ExceedsLimit',
  'Amount exceeds the command limit',
);
export const BelowMinimumError = makeConflictError(
  'BelowMinimum',
  'Amount is below the minimum for this command',
);
export const RainCreditError = makeConflictError(
  'RainCreditError',
  'A recipient wallet is unavailable; rain aborted',
);
export const ChatPlayerNotFoundError = makeNotFoundError('ChatPlayer');
export const GiftNotFoundError = makeNotFoundError('ChatGift');
export const GiftAlreadyClaimedError = makeConflictError(
  'GiftAlreadyClaimed',
  'This gift has already been claimed',
);
export const GiftSelfClaimError = makeConflictError(
  'GiftSelfClaim',
  'You cannot claim your own gift',
);

type ProfileInput = { type: 'profile'; targetUsername: string; roomId: Uuid | null };
type GiftInput = { type: 'gift'; amount: string; roomId: Uuid };
type RainInput = { type: 'rain'; amount: string; roomId: Uuid };
type BlockActionInput = {
  type: 'block' | 'ignore';
  targetUsername: string;
  roomId: Uuid | null;
};
type ExecuteInput = ProfileInput | GiftInput | RainInput | BlockActionInput;

function toDescriptor(row: typeof chatCommandConfig.$inferSelect): ChatCommandDescriptor {
  return {
    key: ChatCommandTypeSchema.parse(row.key),
    enabled: row.enabled,
    label: row.label,
    description: row.description ?? null,
    config: row.config ?? null,
  };
}

export class ChatCommandsService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly systemWriter: ChatSystemWriter,
    private readonly wallet: WalletCommands,
    private readonly directory: AdminUserDirectory,
    private readonly audit: AuditWritePort,
    private readonly transport: RealtimeTransport,
    private readonly events: EventBus,
    private readonly blockWriter: ChatBlockWriter,
  ) {}

  async listCommands(includeDisabled = false): Promise<ChatCommandDescriptor[]> {
    const rows = await this.drizzle.db
      .select()
      .from(chatCommandConfig)
      .where(includeDisabled ? undefined : eq(chatCommandConfig.enabled, true));
    return rows.map(toDescriptor);
  }

  async searchMentions(q: string, limit: number) {
    const ids = await this.directory.findPlayerIds(q, limit);
    if (ids.length === 0) {
      return [];
    }
    const summaries = await this.directory.lookupPlayers(ids);
    return summaries.map((s) => ({ userId: s.userId, username: s.username }));
  }

  async executeCommand(input: ExecuteInput, actorId: Uuid): Promise<ChatSystemMessage> {
    const [row] = await this.drizzle.db
      .select()
      .from(chatCommandConfig)
      .where(eq(chatCommandConfig.key, input.type))
      .limit(1);

    if (!row || !row.enabled) {
      throw new CommandDisabledError(input.type);
    }

    if (input.type === 'profile') {
      return this.handleProfile(input, actorId, row.config ?? null);
    }
    if (input.type === 'gift') {
      return this.handleGift(input, actorId, row.config ?? null);
    }
    if (input.type === 'block' || input.type === 'ignore') {
      return this.handleBlockAction(input, actorId);
    }
    if (input.type === 'rain') {
      return this.handleRain(input, actorId, row.config ?? null);
    }
    // exhaustive — TypeScript cannot narrow a union-literal discriminant ('block'|'ignore') away
    throw new CommandDisabledError(input.type);
  }

  private async handleProfile(
    input: ProfileInput,
    actorId: Uuid,
    _config: CommandConfig | null,
  ): Promise<ChatSystemMessage> {
    const ids = await this.directory.findPlayerIds(input.targetUsername, 20);
    if (ids.length === 0) {
      throw new ChatPlayerNotFoundError(input.targetUsername);
    }
    const summaries = await this.directory.lookupPlayers(ids);
    const summary = summaries.find(
      (s) => s.username.toLowerCase() === input.targetUsername.toLowerCase(),
    );
    if (!summary) {
      throw new ChatPlayerNotFoundError(input.targetUsername);
    }
    return this.systemWriter.postSystemMessage({
      roomId: input.roomId,
      actorId,
      metadata: {
        command: 'profile',
        targetUserId: summary.userId,
        displayName: summary.username,
        // TODO: replace with real level once the player-level system lands
        level: 0,
      },
    });
  }

  private async handleGift(
    input: GiftInput,
    actorId: Uuid,
    config: CommandConfig | null,
  ): Promise<ChatSystemMessage> {
    if (
      config?.maxAmount !== undefined &&
      moneyToNumber(input.amount) > moneyToNumber(config.maxAmount)
    ) {
      throw new ExceedsLimitError();
    }
    if (
      config?.minAmount !== undefined &&
      moneyToNumber(input.amount) < moneyToNumber(config.minAmount)
    ) {
      throw new BelowMinimumError();
    }

    // Resolve sender's username for the gift card metadata.
    const senderSummaries = await this.directory.lookupPlayers([actorId]);
    const senderSummary = senderSummaries.find((s) => s.userId === actorId);
    if (!senderSummary) {
      throw new ChatPlayerNotFoundError(actorId);
    }
    const senderUsername = senderSummary.username;

    const { msg, giftId, currency } = await this.drizzle.db.transaction(async (tx) => {
      const debit = await this.wallet.debit(tx, {
        userId: actorId,
        amount: input.amount,
        type: 'gift',
      });
      if (!debit.ok) {
        throw new InsufficientBalanceError();
      }

      const [giftRow] = await tx
        .insert(chatGift)
        .values({
          senderId: actorId,
          senderUsername,
          amount: input.amount,
          currency: debit.currency,
          roomId: input.roomId,
          // messageId will be updated after postSystemMessage; we use a placeholder UUID
          // that is immediately overwritten by the UPDATE below in the same transaction.
          // Pattern: insert with a temporary value, then set the real foreign reference.
          messageId: '00000000-0000-0000-0000-000000000000',
        })
        .returning();

      if (!giftRow) {
        throw new InsufficientBalanceError();
      }

      const systemMsg = await this.systemWriter.postSystemMessage({
        roomId: input.roomId,
        actorId,
        tx,
        metadata: {
          command: 'gift',
          giftId: giftRow.id,
          senderId: actorId,
          senderUsername,
          amount: input.amount,
          currency: debit.currency,
        },
      });

      // Back-fill the real message id now that we have it.
      await tx.update(chatGift).set({ messageId: systemMsg.id }).where(eq(chatGift.id, giftRow.id));

      return { msg: systemMsg, giftId: giftRow.id, currency: debit.currency };
    });

    await this.audit.record({
      actorId,
      actorType: 'player',
      action: 'chat.gift',
      resourceType: 'chat_gift',
      resourceId: giftId,
      before: null,
      after: { amount: input.amount, roomId: input.roomId },
    });

    void this.events.emit('chat.gift.sent', {
      giftId,
      senderId: actorId,
      senderUsername,
      amount: input.amount,
      currency,
      roomId: input.roomId,
      messageId: msg.id,
    });

    return msg;
  }

  async getGift(giftId: Uuid): Promise<GiftState> {
    const rows = await this.drizzle.db
      .select()
      .from(chatGift)
      .where(eq(chatGift.id, giftId))
      .limit(1);
    const row = findOneOrThrow(rows, new GiftNotFoundError(giftId));
    const serialized = serializeRow(row, {
      dateFields: ['claimedAt', 'createdAt'],
      decimalFields: ['amount'],
    });
    return {
      id: serialized.id,
      senderId: serialized.senderId,
      senderUsername: serialized.senderUsername,
      amount: serialized.amount,
      currency: serialized.currency,
      claimedBy: serialized.claimedBy ?? null,
      claimedByUsername: serialized.claimedByUsername ?? null,
      claimedAt: serialized.claimedAt ?? null,
      createdAt: serialized.createdAt,
    };
  }

  async claimGift(giftId: Uuid, claimerId: Uuid): Promise<ClaimGiftOutput> {
    // Resolve claimer's username upfront — if the claimer is somehow not in the
    // directory that is a hard server error (defensive guard).
    const claimerSummaries = await this.directory.lookupPlayers([claimerId]);
    const claimerSummary = claimerSummaries.find((s) => s.userId === claimerId);
    if (!claimerSummary) {
      throw new GiftNotFoundError(claimerId);
    }
    const claimerUsername = claimerSummary.username;

    // Fetch gift to check self-claim BEFORE attempting the atomic update.
    const existing = await this.drizzle.db
      .select()
      .from(chatGift)
      .where(eq(chatGift.id, giftId))
      .limit(1);
    const giftRow = findOneOrThrow(existing, new GiftNotFoundError(giftId));

    if (giftRow.senderId === claimerId) {
      throw new GiftSelfClaimError();
    }

    const { claimed, currency, roomId } = await this.drizzle.db.transaction(async (tx) => {
      const claimedAt = new Date();
      const results = await tx
        .update(chatGift)
        .set({ claimedBy: claimerId, claimedByUsername: claimerUsername, claimedAt })
        .where(and(eq(chatGift.id, giftId), isNull(chatGift.claimedBy)))
        .returning();

      if (results.length === 0) {
        // Another claimer won the race.
        throw new GiftAlreadyClaimedError();
      }

      const updated = findOneOrThrow(results, new GiftAlreadyClaimedError());

      const credit = await this.wallet.credit(tx, {
        userId: claimerId,
        amount: updated.amount,
        type: 'gift',
      });
      if (!credit.ok) {
        throw new GiftNotFoundError(claimerId);
      }

      return { claimed: updated, currency: updated.currency, roomId: updated.roomId };
    });

    await this.audit.record({
      actorId: claimerId,
      actorType: 'player',
      action: 'chat.gift.claimed',
      resourceType: 'chat_gift',
      resourceId: giftId,
      before: null,
      after: { claimedBy: claimerId, amount: claimed.amount },
    });

    void this.transport.publish(chatChannel(roomId), {
      event: 'gift.claimed',
      giftId,
      claimedBy: claimerId,
      claimedByUsername: claimerUsername,
      claimedAt: claimed.claimedAt?.toISOString() ?? new Date().toISOString(),
    });

    void this.events.emit('chat.gift.claimed', {
      giftId,
      claimerId,
      claimerUsername,
      senderId: giftRow.senderId,
      amount: claimed.amount,
      currency,
      roomId,
    });

    return {
      claimedBy: claimerId,
      claimedByUsername: claimerUsername,
      claimedAt: claimed.claimedAt?.toISOString() ?? new Date().toISOString(),
    };
  }

  private async handleRain(
    input: RainInput,
    actorId: Uuid,
    config: CommandConfig | null,
  ): Promise<ChatSystemMessage> {
    const allOnline = await this.transport.getOnlineUserIds(chatChannel(input.roomId));
    const maxRecipients = config?.maxRecipients ?? 50;
    const recipients = allOnline.filter((id) => id !== actorId).slice(0, maxRecipients);
    if (recipients.length === 0) {
      throw new NoOnlineUsersError();
    }
    const { msg, currency } = await this.drizzle.db.transaction(async (tx) => {
      const splitResult = await tx.execute(
        sql`SELECT (floor(${input.amount}::numeric / ${recipients.length}))::text AS per_recipient`,
      );
      const perRecipient = (splitResult.rows[0] as { per_recipient: string }).per_recipient;
      const debit = await this.wallet.debit(tx, {
        userId: actorId,
        amount: input.amount,
        type: 'rain',
      });
      if (!debit.ok) {
        throw new InsufficientBalanceError();
      }
      const credits = await mapConcurrent(recipients, 10, (userId) =>
        this.wallet.credit(tx, { userId, amount: perRecipient, type: 'rain' }),
      );
      if (credits.some((c) => !c.ok)) {
        throw new RainCreditError();
      }
      const systemMsg = await this.systemWriter.postSystemMessage({
        roomId: input.roomId,
        actorId,
        tx,
        metadata: {
          command: 'rain',
          fromUserId: actorId,
          amount: input.amount,
          currency: debit.currency,
          recipientCount: recipients.length,
          perRecipient,
        },
      });
      return { msg: systemMsg, currency: debit.currency };
    });
    await this.audit.record({
      actorId,
      actorType: 'player',
      action: 'chat.rain',
      resourceType: 'chat_room',
      resourceId: input.roomId,
      before: null,
      after: { amount: input.amount, recipientCount: recipients.length },
    });
    /* Should be used to notify receiver using map() */
    void this.events.emit('chat.rain.distributed', {
      fromUserId: actorId,
      recipientCount: recipients.length,
      totalAmount: input.amount,
      currency,
      roomId: input.roomId,
    });
    return msg;
  }

  /** Command must be used to update users that chat commands setup has been invalidated and needs to be refetched */
  private async handleBlockAction(
    input: BlockActionInput,
    actorId: Uuid,
  ): Promise<ChatSystemMessage> {
    const ids = await this.directory.findPlayerIds(input.targetUsername, 20);
    if (ids.length === 0) {
      throw new ChatPlayerNotFoundError(input.targetUsername);
    }
    const summaries = await this.directory.lookupPlayers(ids);
    const summary = summaries.find(
      (s) => s.username.toLowerCase() === input.targetUsername.toLowerCase(),
    );
    if (!summary) {
      throw new ChatPlayerNotFoundError(input.targetUsername);
    }
    await this.blockWriter.blockUser(actorId, summary.userId);
    return this.systemWriter.postSystemMessage({
      roomId: input.roomId,
      actorId,
      metadata: {
        command: input.type,
        targetUserId: summary.userId,
        displayName: summary.username,
      },
    });
  }

  async adminUpdateCommand(
    input: { key: ChatCommandType; enabled: boolean; config?: CommandConfig },
    actorId: Uuid,
  ): Promise<ChatCommandDescriptor> {
    const rows = await this.drizzle.db
      .insert(chatCommandConfig)
      .values({
        key: input.key,
        enabled: input.enabled,
        label: input.key.charAt(0).toUpperCase() + input.key.slice(1),
        config: input.config ?? null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: chatCommandConfig.key,
        set: {
          enabled: input.enabled,
          ...(input.config !== undefined ? { config: input.config } : {}),
          updatedAt: new Date(),
        },
      })
      .returning();
    const row = findOneOrThrow(rows, new CommandDisabledError(input.key));
    await this.audit.record({
      actorId,
      actorType: 'admin',
      action: 'chat.command.updated',
      resourceType: 'chat_command',
      resourceId: input.key,
      before: null,
      after: { enabled: input.enabled, config: input.config ?? null },
    });
    return toDescriptor(row);
  }
}

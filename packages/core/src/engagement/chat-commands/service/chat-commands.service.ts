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
  type DrizzleTx,
} from '@openora/core/server';
import type {
  Uuid,
  ChatSystemMessage,
  ChatSystemWriter,
  ChatBlockWriter,
  WalletCommands,
  AdminUserDirectory,
  AdminGameReporting,
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
  PlayerSearchResult,
  PlayerProfileCard,
} from '../contract/index.js';
import { ChatCommandTypeSchema } from '../contract/index.js';
import { chatCommandConfig, chatGift, chatCommandIdempotency } from '../schema/index.js';

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
export const DonateSelfError = makeConflictError('DonateSelf', 'You cannot donate to yourself');
export const SelfModerationActionError = makeConflictError(
  'SelfModerationAction',
  'You cannot block or ignore yourself',
);
export const TooManyRecipientsError = makeConflictError(
  'TooManyRecipients',
  'Amount too small: you need at least $1 per recipient',
);
export const ChatCommandIdempotencyKeyReuseError = makeConflictError(
  'ChatCommandIdempotencyKeyReuse',
  'This idempotency key was already used with a different amount',
);
export const ConcurrentCommandReplayError = makeConflictError(
  'ConcurrentCommandReplay',
  'This request is already being processed - please retry',
);

type GiftInput = { type: 'gift'; amount: string; roomId: Uuid; idempotencyKey?: Uuid };
type RainInput = {
  type: 'rain';
  amount: string;
  recipientCount: number;
  roomId: Uuid;
  idempotencyKey?: Uuid;
};
type DonateInput = {
  type: 'donate';
  targetUsername: string;
  amount: string;
  roomId: Uuid | null;
  idempotencyKey?: Uuid;
};
type BlockActionInput = {
  type: 'block' | 'ignore';
  targetUsername: string;
  roomId: Uuid | null;
};
type ExecuteInput = GiftInput | RainInput | DonateInput | BlockActionInput;

function shuffleArray<T>(arr: readonly T[]): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = result.at(i);
    const b = result.at(j);
    if (a !== undefined && b !== undefined) {
      result[i] = b;
      result[j] = a;
    }
  }
  return result;
}

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
    private readonly gameReporting: AdminGameReporting,
  ) {}

  async listCommands(includeDisabled = false): Promise<ChatCommandDescriptor[]> {
    const rows = await this.drizzle.db
      .select()
      .from(chatCommandConfig)
      .where(includeDisabled ? undefined : eq(chatCommandConfig.enabled, true));
    return rows.map(toDescriptor);
  }

  async searchMentions(q: string, limit: number, viewerId: Uuid) {
    const ids = await this.directory.findPlayerIds(q, limit);
    if (ids.length === 0) {
      return [];
    }
    const excluded = new Set(await this.blockWriter.getExcludedUserIds(viewerId));
    const filteredIds = ids.filter((id) => !excluded.has(id));
    if (filteredIds.length === 0) {
      return [];
    }
    const summaries = await this.directory.lookupPlayers(filteredIds);
    return summaries.map((s) => ({ userId: s.userId, username: s.username }));
  }

  async searchPlayers(q: string, limit: number, viewerId: Uuid): Promise<PlayerSearchResult[]> {
    const ids = await this.directory.findPlayerIds(q, limit);
    if (ids.length === 0) {
      return [];
    }
    const excluded = new Set(await this.blockWriter.getExcludedUserIds(viewerId));
    const filteredIds = ids.filter((id) => !excluded.has(id));
    if (filteredIds.length === 0) {
      return [];
    }
    const summaries = await this.directory.lookupPlayers(filteredIds);
    return summaries.map((s) => ({
      userId: s.userId,
      username: s.username,
      avatarUrl: s.avatarUrl,
      level: s.level,
    }));
  }

  async getPlayerProfile(userId: Uuid): Promise<PlayerProfileCard> {
    const summaries = await this.directory.lookupPlayers([userId]);
    const summary = summaries.find((s) => s.userId === userId);
    if (!summary) {
      throw new ChatPlayerNotFoundError(userId);
    }
    const stats = await this.gameReporting.getPlayerStats(userId);
    return {
      userId: summary.userId,
      username: summary.username,
      avatarUrl: summary.avatarUrl,
      level: summary.level,
      joinedAt: summary.createdAt.toISOString(),
      totalWagered: stats.totalWagered,
      totalBets: stats.totalBets,
      currency: summary.currency,
    };
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

    if (input.type === 'gift') {
      return this.handleGift(input, actorId, row.config ?? null);
    }
    if (input.type === 'donate') {
      return this.handleDonate(input, actorId, row.config ?? null);
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

  // Pre-transaction replay check shared by gift/rain/donate: a stored row with a
  // matching amount is a genuine replay (return its stored result); a matching key
  // with a DIFFERENT amount is a reused key, not a replay (ChatCommandIdempotencyKeyReuseError).
  private async findCommandReplay(
    commandType: 'gift' | 'rain' | 'donate',
    actorId: Uuid,
    idempotencyKey: Uuid,
    amount: string,
  ): Promise<ChatSystemMessage | null> {
    const [row] = await this.drizzle.db
      .select()
      .from(chatCommandIdempotency)
      .where(
        and(
          eq(chatCommandIdempotency.actorId, actorId),
          eq(chatCommandIdempotency.commandType, commandType),
          eq(chatCommandIdempotency.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    if (!row) {
      return null;
    }
    if (moneyToNumber(row.amount) !== moneyToNumber(amount)) {
      throw new ChatCommandIdempotencyKeyReuseError();
    }
    return row.result ?? null;
  }

  // Inserted (result: null) as the FIRST statement inside the caller's money-moving
  // transaction, before any debit - the row IS the atomic guard. A concurrent duplicate
  // loses the unique-index race (onConflictDoNothing) and must not touch money, so it
  // throws ConcurrentCommandReplayError rather than silently proceeding; the caller's
  // own retry then finds the row via findCommandReplay instead. Returns undefined when
  // no idempotencyKey was supplied (guard is a no-op).
  private async guardCommandIdempotency(
    tx: DrizzleTx,
    commandType: 'gift' | 'rain' | 'donate',
    actorId: Uuid,
    idempotencyKey: Uuid | undefined,
    amount: string,
  ): Promise<Uuid | undefined> {
    if (!idempotencyKey) {
      return undefined;
    }
    const [inserted] = await tx
      .insert(chatCommandIdempotency)
      .values({ actorId, commandType, idempotencyKey, amount, result: null })
      .onConflictDoNothing({
        target: [
          chatCommandIdempotency.actorId,
          chatCommandIdempotency.commandType,
          chatCommandIdempotency.idempotencyKey,
        ],
      })
      .returning();
    if (!inserted) {
      throw new ConcurrentCommandReplayError();
    }
    return inserted.id;
  }

  // Exact, case-insensitive username resolution for callers holding a complete, already-known
  // username (never a partial search term) - `/donate`, `/block`, `/ignore`. Distinct from
  // findPlayerIds' capped fuzzy substring search, which can silently drop the real match once
  // more than 20 unrelated accounts substring-collide with a short/common username.
  private async resolveExactPlayer(username: string) {
    const summary = await this.directory.getPlayerByUsername(username);
    if (!summary) {
      throw new ChatPlayerNotFoundError(username);
    }
    return summary;
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

    if (input.idempotencyKey) {
      const replay = await this.findCommandReplay(
        'gift',
        actorId,
        input.idempotencyKey,
        input.amount,
      );
      if (replay) {
        return replay;
      }
    }

    // Resolve sender's username for the gift card metadata.
    const senderSummaries = await this.directory.lookupPlayers([actorId]);
    const senderSummary = senderSummaries.find((s) => s.userId === actorId);
    if (!senderSummary) {
      throw new ChatPlayerNotFoundError(actorId);
    }
    const senderUsername = senderSummary.username;

    const { msg, giftId, currency } = await this.drizzle.db.transaction(async (tx) => {
      const idempotencyRowId = await this.guardCommandIdempotency(
        tx,
        'gift',
        actorId,
        input.idempotencyKey,
        input.amount,
      );

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

      if (idempotencyRowId) {
        await tx
          .update(chatCommandIdempotency)
          .set({ result: systemMsg })
          .where(eq(chatCommandIdempotency.id, idempotencyRowId));
      }

      return { msg: systemMsg, giftId: giftRow.id, currency: debit.currency };
    });

    // The caller now owns the commit boundary: postSystemMessage was passed `tx` above so
    // it did not auto-publish - publish only now that this transaction has committed.
    void this.transport.publish(chatChannel(input.roomId), msg);

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

    const configMax = config?.maxRecipients ?? 50;
    if (input.recipientCount > configMax) {
      throw new ExceedsLimitError();
    }
    const amountUnits = Math.floor(moneyToNumber(input.amount));
    if (input.recipientCount > amountUnits) {
      throw new TooManyRecipientsError();
    }
    const allOnline = await this.transport.getOnlineUserIds(chatChannel(input.roomId));
    const recipients = shuffleArray(allOnline.filter((id) => id !== actorId)).slice(
      0,
      input.recipientCount,
    );
    if (recipients.length === 0) {
      throw new NoOnlineUsersError();
    }

    if (input.idempotencyKey) {
      const replay = await this.findCommandReplay(
        'rain',
        actorId,
        input.idempotencyKey,
        input.amount,
      );
      if (replay) {
        return replay;
      }
    }

    const { msg, currency, totalDistributed } = await this.drizzle.db.transaction(async (tx) => {
      const idempotencyRowId = await this.guardCommandIdempotency(
        tx,
        'rain',
        actorId,
        input.idempotencyKey,
        input.amount,
      );

      const splitResult = await tx.execute(
        sql`SELECT
              (floor(${input.amount}::numeric / ${recipients.length}))::text AS per_recipient,
              (floor(${input.amount}::numeric / ${recipients.length}) * ${recipients.length})::text AS total_distributed`,
      );
      const { per_recipient: perRecipient, total_distributed: totalDistributed } = splitResult
        .rows[0] as {
        per_recipient: string;
        total_distributed: string;
      };
      const debit = await this.wallet.debit(tx, {
        userId: actorId,
        amount: totalDistributed,
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
          amount: totalDistributed,
          currency: debit.currency,
          recipientCount: recipients.length,
          perRecipient,
        },
      });

      if (idempotencyRowId) {
        await tx
          .update(chatCommandIdempotency)
          .set({ result: systemMsg })
          .where(eq(chatCommandIdempotency.id, idempotencyRowId));
      }

      return { msg: systemMsg, currency: debit.currency, totalDistributed };
    });

    void this.transport.publish(chatChannel(input.roomId), msg);

    await this.audit.record({
      actorId,
      actorType: 'player',
      action: 'chat.rain',
      resourceType: 'chat_room',
      resourceId: input.roomId,
      before: null,
      after: { amount: totalDistributed, recipientCount: recipients.length },
    });
    void this.events.emit('chat.rain.distributed', {
      fromUserId: actorId,
      recipients,
      recipientCount: recipients.length,
      totalAmount: totalDistributed,
      currency,
      roomId: input.roomId,
    });
    return msg;
  }

  private async handleDonate(
    input: DonateInput,
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

    const target = await this.resolveExactPlayer(input.targetUsername);

    if (target.userId === actorId) {
      throw new DonateSelfError();
    }

    const senderSummaries = await this.directory.lookupPlayers([actorId]);
    const sender = senderSummaries.find((s) => s.userId === actorId);
    if (!sender) {
      throw new ChatPlayerNotFoundError(actorId);
    }

    if (input.idempotencyKey) {
      const replay = await this.findCommandReplay(
        'donate',
        actorId,
        input.idempotencyKey,
        input.amount,
      );
      if (replay) {
        return replay;
      }
    }

    const { msg, currency } = await this.drizzle.db.transaction(async (tx) => {
      const idempotencyRowId = await this.guardCommandIdempotency(
        tx,
        'donate',
        actorId,
        input.idempotencyKey,
        input.amount,
      );

      const debit = await this.wallet.debit(tx, {
        userId: actorId,
        amount: input.amount,
        type: 'tip',
      });
      if (!debit.ok) {
        throw new InsufficientBalanceError();
      }

      const credit = await this.wallet.credit(tx, {
        userId: target.userId,
        amount: input.amount,
        type: 'tip',
      });
      if (!credit.ok) {
        throw new ChatPlayerNotFoundError(target.userId);
      }

      const systemMsg = await this.systemWriter.postSystemMessage({
        roomId: input.roomId,
        actorId,
        tx,
        metadata: {
          command: 'donate',
          recipientId: target.userId,
          recipientUsername: target.username,
          amount: input.amount,
          currency: debit.currency,
        },
      });

      if (idempotencyRowId) {
        await tx
          .update(chatCommandIdempotency)
          .set({ result: systemMsg })
          .where(eq(chatCommandIdempotency.id, idempotencyRowId));
      }

      return { msg: systemMsg, currency: debit.currency };
    });

    void this.transport.publish(chatChannel(input.roomId), msg);

    await this.audit.record({
      actorId,
      actorType: 'player',
      action: 'chat.donate',
      resourceType: 'chat_donation',
      resourceId: msg.id,
      before: null,
      after: { recipientId: target.userId, amount: input.amount, currency },
    });

    void this.events.emit('chat.donate.sent', {
      senderId: actorId,
      senderUsername: sender.username,
      recipientId: target.userId,
      recipientUsername: target.username,
      amount: input.amount,
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
    const summary = await this.resolveExactPlayer(input.targetUsername);
    if (summary.userId === actorId) {
      throw new SelfModerationActionError();
    }
    if (input.type === 'block') {
      await this.blockWriter.blockUser(actorId, summary.userId);
    } else {
      await this.blockWriter.ignoreUser(actorId, summary.userId);
    }
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

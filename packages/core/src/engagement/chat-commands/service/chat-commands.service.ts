import { createHash } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  DrizzleService,
  makeNotFoundError,
  makeConflictError,
  mapConcurrent,
  moneyToNumber,
  findOneOrThrow,
  serializeRow,
  createDomainError,
  type EventBus,
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
  ChatRoomAccess,
  CacheAdapter,
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
  'This idempotency key was already used with different request parameters',
);
export const ConcurrentCommandReplayError = makeConflictError(
  'ConcurrentCommandReplay',
  'This request is already being processed - please retry',
);
export const ChatRoomNotMemberError = createDomainError(
  'ChatRoomNotMemberError',
  (roomId: Uuid) => `You are not a member of room: ${roomId}`,
);

type GiftInput = { type: 'gift'; amount: string; roomId: Uuid; idempotencyKey: Uuid };
type RainInput = {
  type: 'rain';
  amount: string;
  recipientCount: number;
  roomId: Uuid;
  idempotencyKey: Uuid;
};
type DonateInput = {
  type: 'donate';
  targetUsername: string;
  amount: string;
  roomId: Uuid | null;
  idempotencyKey: Uuid;
};
type BlockActionInput = {
  type: 'block' | 'ignore';
  targetUsername: string;
  roomId: Uuid | null;
};
type ExecuteInput = GiftInput | RainInput | DonateInput | BlockActionInput;
type MoneyMovingInput = GiftInput | RainInput | DonateInput;

const COMMAND_IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;
type CommandIdempotencyRecord = {
  fingerprint: string;
  result: ChatSystemMessage | null;
};

// The replay guard must match on the COMPLETE request, not just the amount - a reused
// key with a different room, recipient count, or donate target is a distinct request,
// not a replay of the original. `idempotencyKey` itself is excluded so the fingerprint
// is stable for the row it guards.
export function fingerprintCommand(input: MoneyMovingInput): string {
  const canonical: Record<string, unknown> =
    input.type === 'gift'
      ? { type: input.type, amount: input.amount, roomId: input.roomId }
      : input.type === 'rain'
        ? {
            type: input.type,
            amount: input.amount,
            recipientCount: input.recipientCount,
            roomId: input.roomId,
          }
        : {
            type: input.type,
            amount: input.amount,
            targetUsername: input.targetUsername,
            roomId: input.roomId,
          };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

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
    private readonly roomAccess: ChatRoomAccess,
    private readonly cache: CacheAdapter,
    private readonly idempotencyTtlMs = COMMAND_IDEMPOTENCY_TTL_MS,
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

  async getPlayerProfile(userId: Uuid, viewerId: Uuid): Promise<PlayerProfileCard> {
    const summaries = await this.directory.lookupPlayers([userId]);
    const summary = summaries.find((s) => s.userId === userId);
    if (!summary) {
      throw new ChatPlayerNotFoundError(userId);
    }
    const isSelf = userId === viewerId;
    const stats = isSelf ? await this.gameReporting.getPlayerStats(userId) : null;
    return {
      userId: summary.userId,
      username: summary.username,
      avatarUrl: summary.avatarUrl,
      level: summary.level,
      joinedAt: isSelf ? summary.createdAt.toISOString() : null,
      totalWagered: stats?.totalWagered ?? null,
      totalBets: stats?.totalBets ?? null,
      currency: isSelf ? summary.currency : null,
    };
  }

  async executeCommand(input: ExecuteInput, actorId: Uuid): Promise<ChatSystemMessage> {
    if (input.roomId) {
      try {
        await this.roomAccess.verifyRoomAccess(input.roomId, actorId);
      } catch (error) {
        if (error instanceof Error && error.name === 'ChatRoomNotMemberError') {
          throw new ChatRoomNotMemberError(input.roomId);
        }
        throw error;
      }
    }
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

  private async findCommandReplay(
    commandType: 'gift' | 'rain' | 'donate',
    actorId: Uuid,
    idempotencyKey: Uuid,
    fingerprint: string,
  ): Promise<ChatSystemMessage | null> {
    const record = await this.cache.get<CommandIdempotencyRecord>(
      this.idempotencyCacheKey(commandType, actorId, idempotencyKey),
    );
    if (!record) {
      return null;
    }
    if (record.fingerprint !== fingerprint) {
      throw new ChatCommandIdempotencyKeyReuseError();
    }
    if (!record.result) {
      throw new ConcurrentCommandReplayError();
    }
    return record.result;
  }

  private idempotencyCacheKey(
    commandType: 'gift' | 'rain' | 'donate',
    actorId: Uuid,
    idempotencyKey: Uuid,
  ): string {
    return `chat-command:idempotency:${actorId}:${commandType}:${idempotencyKey}`;
  }

  private async reserveCommandIdempotency(
    commandType: 'gift' | 'rain' | 'donate',
    actorId: Uuid,
    idempotencyKey: Uuid,
    fingerprint: string,
  ): Promise<void> {
    const reserved = await this.cache.setIfAbsent(
      this.idempotencyCacheKey(commandType, actorId, idempotencyKey),
      { fingerprint, result: null } satisfies CommandIdempotencyRecord,
      { ttlMs: this.idempotencyTtlMs },
    );
    if (!reserved) {
      throw new ConcurrentCommandReplayError();
    }
  }

  private async completeCommandIdempotency(
    commandType: 'gift' | 'rain' | 'donate',
    actorId: Uuid,
    idempotencyKey: Uuid,
    fingerprint: string,
    result: ChatSystemMessage,
  ): Promise<void> {
    await this.cache.set(
      this.idempotencyCacheKey(commandType, actorId, idempotencyKey),
      { fingerprint, result } satisfies CommandIdempotencyRecord,
      { ttlMs: this.idempotencyTtlMs },
    );
  }

  private async runWithCommandReservation<T>(
    commandType: 'gift' | 'rain' | 'donate',
    actorId: Uuid,
    idempotencyKey: Uuid,
    work: () => Promise<T>,
  ): Promise<T> {
    try {
      return await work();
    } catch (error) {
      await this.cache.delete(this.idempotencyCacheKey(commandType, actorId, idempotencyKey));
      throw error;
    }
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

    const fingerprint = fingerprintCommand(input);
    const replay = await this.findCommandReplay('gift', actorId, input.idempotencyKey, fingerprint);
    if (replay) {
      return replay;
    }
    await this.reserveCommandIdempotency('gift', actorId, input.idempotencyKey, fingerprint);

    // Resolve sender's username for the gift card metadata.
    const senderSummaries = await this.directory.lookupPlayers([actorId]);
    const senderSummary = senderSummaries.find((s) => s.userId === actorId);
    if (!senderSummary) {
      throw new ChatPlayerNotFoundError(actorId);
    }
    const senderUsername = senderSummary.username;

    const { msg, giftId, currency } = await this.runWithCommandReservation(
      'gift',
      actorId,
      input.idempotencyKey,
      () =>
        this.drizzle.db.transaction(async (tx) => {
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
          await tx
            .update(chatGift)
            .set({ messageId: systemMsg.id })
            .where(eq(chatGift.id, giftRow.id));

          await this.audit.recordInTransaction(tx, {
            actorId,
            actorType: 'player',
            action: 'chat.gift',
            resourceType: 'chat_gift',
            resourceId: giftRow.id,
            before: null,
            after: { amount: input.amount, roomId: input.roomId },
          });

          return { msg: systemMsg, giftId: giftRow.id, currency: debit.currency };
        }),
    );
    await this.completeCommandIdempotency('gift', actorId, input.idempotencyKey, fingerprint, msg);

    // The caller now owns the commit boundary: postSystemMessage was passed `tx` above so
    // it did not auto-publish - publish only now that this transaction has committed.
    void this.transport.publish(chatChannel(input.roomId), msg);

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

  async getGift(giftId: Uuid, viewerId: Uuid): Promise<GiftState> {
    const rows = await this.drizzle.db
      .select()
      .from(chatGift)
      .where(eq(chatGift.id, giftId))
      .limit(1);
    const row = findOneOrThrow(rows, new GiftNotFoundError(giftId));
    await this.roomAccess.verifyRoomAccess(row.roomId, viewerId);
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
    await this.roomAccess.verifyRoomAccess(giftRow.roomId, claimerId);

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
        currency: updated.currency,
        type: 'gift',
      });
      if (!credit.ok) {
        throw new GiftNotFoundError(claimerId);
      }

      await this.audit.recordInTransaction(tx, {
        actorId: claimerId,
        actorType: 'player',
        action: 'chat.gift.claimed',
        resourceType: 'chat_gift',
        resourceId: giftId,
        before: null,
        after: { claimedBy: claimerId, amount: updated.amount },
      });

      return { claimed: updated, currency: updated.currency, roomId: updated.roomId };
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
    const fingerprint = fingerprintCommand(input);
    const replay = await this.findCommandReplay('rain', actorId, input.idempotencyKey, fingerprint);
    if (replay) {
      return replay;
    }
    await this.reserveCommandIdempotency('rain', actorId, input.idempotencyKey, fingerprint);

    const allOnline = await this.transport.getOnlineUserIds(chatChannel(input.roomId));
    const recipients = shuffleArray(allOnline.filter((id) => id !== actorId)).slice(
      0,
      input.recipientCount,
    );
    if (recipients.length === 0) {
      throw new NoOnlineUsersError();
    }

    const { msg, currency, totalDistributed } = await this.runWithCommandReservation(
      'rain',
      actorId,
      input.idempotencyKey,
      () =>
        this.drizzle.db.transaction(async (tx) => {
          const splitResult = await tx.execute(
            sql`SELECT
              (floor(floor(${input.amount}::numeric) / ${recipients.length}))::text AS per_recipient,
              (floor(floor(${input.amount}::numeric) / ${recipients.length}) * ${recipients.length})::text AS total_distributed`,
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
            this.wallet.credit(tx, {
              userId,
              amount: perRecipient,
              currency: debit.currency,
              type: 'rain',
            }),
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

          await this.audit.recordInTransaction(tx, {
            actorId,
            actorType: 'player',
            action: 'chat.rain',
            resourceType: 'chat_room',
            resourceId: input.roomId,
            before: null,
            after: { amount: totalDistributed, recipientCount: recipients.length },
          });

          return { msg: systemMsg, currency: debit.currency, totalDistributed };
        }),
    );
    await this.completeCommandIdempotency('rain', actorId, input.idempotencyKey, fingerprint, msg);

    void this.transport.publish(chatChannel(input.roomId), msg);

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

    const fingerprint = fingerprintCommand(input);
    const replay = await this.findCommandReplay(
      'donate',
      actorId,
      input.idempotencyKey,
      fingerprint,
    );
    if (replay) {
      return replay;
    }
    await this.reserveCommandIdempotency('donate', actorId, input.idempotencyKey, fingerprint);

    const { msg, currency } = await this.runWithCommandReservation(
      'donate',
      actorId,
      input.idempotencyKey,
      () =>
        this.drizzle.db.transaction(async (tx) => {
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
            currency: debit.currency,
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

          await this.audit.recordInTransaction(tx, {
            actorId,
            actorType: 'player',
            action: 'chat.donate',
            resourceType: 'chat_donation',
            resourceId: systemMsg.id,
            before: null,
            after: { recipientId: target.userId, amount: input.amount, currency: debit.currency },
          });

          return { msg: systemMsg, currency: debit.currency };
        }),
    );
    await this.completeCommandIdempotency(
      'donate',
      actorId,
      input.idempotencyKey,
      fingerprint,
      msg,
    );

    void this.transport.publish(chatChannel(input.roomId), msg);

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

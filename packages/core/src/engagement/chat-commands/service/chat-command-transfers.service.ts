import { createHash } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  DrizzleService,
  createLogger,
  makeNotFoundError,
  makeConflictError,
  mapConcurrent,
  moneyToNumber,
  findOneOrThrow,
  createDomainError,
  type EventBus,
  type DrizzleDb,
  type DrizzleTx,
} from '@openora/core/server';
import type {
  Uuid,
  CommandChatMessage,
  ChatSystemWriter,
  WalletCommands,
  AdminUserDirectory,
  AuditWritePort,
  RealtimeTransport,
  ChatRoomAccess,
  ChatBlockWriter,
  CacheAdapter,
  SendGiftArgs,
  SendGiftResult,
  ClaimGiftResult,
  GetGiftResult,
  GiftSnapshot,
  GiftCommands,
  SendRainArgs,
  SendRainResult,
  RainCommands,
} from '@openora/core/contracts';
import { chatChannel } from '@openora/core/contracts';
import { chatCommandConfig } from '@openora/core/engagement/schema/chat-commands';
import type { SendDonateInput } from '../contract/index.js';
import {
  chatCommandIdempotency,
  playerGift,
  playerDonate,
  playerRain,
  playerRainReceiver,
} from '../schema/index.js';

const logger = createLogger('chat-commands');

function publishChatEvent<T>(transport: RealtimeTransport, roomId: Uuid | null, event: T): void {
  void Promise.resolve()
    .then(() => transport.publish(chatChannel(roomId), event))
    .catch((err: unknown) => {
      logger.error({ err, roomId }, 'chat realtime publish failed');
    });
}

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
export class ChatPlayerNotFoundError extends Error {
  constructor(readonly playerId: string) {
    super(`ChatPlayer not found: ${playerId}`);
    this.name = 'ChatPlayerNotFoundError';
  }
}

export const GiftNotFoundError = makeNotFoundError('ChatGift');
export const GiftAlreadyClaimedError = makeConflictError(
  'GiftAlreadyClaimed',
  'This gift has already been claimed',
);
export const GiftSelfClaimError = makeConflictError(
  'GiftSelfClaim',
  'You cannot claim your own gift',
);
export const GiftCreditError = makeConflictError(
  'GiftCreditError',
  'Recipient wallet is unavailable; gift claim aborted',
);
export const DonateSelfError = makeConflictError('DonateSelf', 'You cannot donate to yourself');
export const BlockedRecipientError = makeConflictError(
  'BlockedRecipient',
  'You cannot send money to a user you blocked',
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
  (roomId: Uuid | null) =>
    roomId ? `You are not a member of room: ${roomId}` : 'You are not a member of global chat',
);

// Internal-only: createDomainError instances don't expose their constructor args as
// properties, so this carries the gift's roomId across the doClaimGift -> toClaimGiftResult
// boundary - without it, the ClaimGiftResult's room_not_member reason has no roomId, and
// chat-commands (which only has giftId in scope) would build a ChatRoomNotMemberError with
// the wrong id. Never crosses the GIFT_COMMANDS port boundary itself.
class GiftRoomAccessError extends Error {
  constructor(readonly roomId: Uuid | null) {
    super('room_not_member');
    this.name = 'GiftRoomAccessError';
  }
}

type GiftArgs = { amount: string; roomId: Uuid | null; idempotencyKey: Uuid };
type RainFingerprintArgs = Pick<
  SendRainArgs,
  'amount' | 'recipientCount' | 'roomId' | 'idempotencyKey'
>;
type DonateArgs = {
  targetUsername: string;
  amount: string;
  roomId: Uuid | null;
  idempotencyKey: Uuid;
};
type MoneyMovingInput =
  | ({ type: 'gift' } & GiftArgs)
  | ({ type: 'rain' } & RainFingerprintArgs)
  | ({ type: 'donate' } & DonateArgs);

export async function calculateRainSplit(
  tx: DrizzleTx,
  amount: string,
  requestedRecipientCount: number,
  actualRecipientCount: number,
): Promise<{ perRecipient: string; totalDistributed: string }> {
  const splitResult = await tx.execute(
    sql`SELECT
      (floor(${amount}::numeric * 100 / ${requestedRecipientCount}) / 100)::text AS per_recipient,
      (floor(${amount}::numeric * 100 / ${requestedRecipientCount}) / 100 * ${actualRecipientCount})::text AS total_distributed,
      (floor(${amount}::numeric * 100 / ${requestedRecipientCount}) / 100 > 0) AS has_positive_recipient`,
  );
  const {
    per_recipient: perRecipient,
    total_distributed: totalDistributed,
    has_positive_recipient: hasPositiveRecipient,
  } = splitResult.rows[0] as {
    per_recipient: string;
    total_distributed: string;
    has_positive_recipient: boolean;
  };
  if (!hasPositiveRecipient) {
    throw new TooManyRecipientsError();
  }
  return { perRecipient, totalDistributed };
}

const COMMAND_IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;
type CommandIdempotencyRecord = {
  fingerprint: string;
  result: CommandChatMessage | null;
};

type DurableCommandClaim = {
  id: Uuid;
  replay: CommandChatMessage | null;
};

// The replay guard must match on the COMPLETE request, not just the amount - a reused
// key with a different room, recipient count, or donate target is a distinct request,
// not a replay of the original. `idempotencyKey` itself is excluded so the fingerprint
// is stable for the row it guards. The cache-key namespace stays `chat-command:*` even
// though this logic now lives here - see AGENTS.md.
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

async function claimDurableCommand(
  tx: DrizzleTx,
  {
    commandType,
    actorId,
    idempotencyKey,
    fingerprint,
  }: {
    commandType: 'gift' | 'rain' | 'donate';
    actorId: Uuid;
    idempotencyKey: Uuid;
    fingerprint: string;
  },
): Promise<DurableCommandClaim> {
  const [inserted] = await tx
    .insert(chatCommandIdempotency)
    .values({ actorId, commandType, idempotencyKey, fingerprint })
    .onConflictDoNothing({
      target: [
        chatCommandIdempotency.actorId,
        chatCommandIdempotency.commandType,
        chatCommandIdempotency.idempotencyKey,
      ],
    })
    .returning({ id: chatCommandIdempotency.id });

  if (inserted) {
    return { id: inserted.id, replay: null };
  }

  const [existing] = await tx
    .select({
      id: chatCommandIdempotency.id,
      fingerprint: chatCommandIdempotency.fingerprint,
      result: chatCommandIdempotency.result,
    })
    .from(chatCommandIdempotency)
    .where(
      and(
        eq(chatCommandIdempotency.actorId, actorId),
        eq(chatCommandIdempotency.commandType, commandType),
        eq(chatCommandIdempotency.idempotencyKey, idempotencyKey),
      ),
    )
    .for('update');

  if (!existing) {
    throw new ConcurrentCommandReplayError();
  }
  if (existing.fingerprint !== fingerprint) {
    throw new ChatCommandIdempotencyKeyReuseError();
  }
  if (!existing.result) {
    throw new ConcurrentCommandReplayError();
  }
  return { id: existing.id, replay: existing.result };
}

async function findDurableCommandReplay(
  db: DrizzleDb,
  {
    commandType,
    actorId,
    idempotencyKey,
    fingerprint,
  }: {
    commandType: 'gift' | 'rain' | 'donate';
    actorId: Uuid;
    idempotencyKey: Uuid;
    fingerprint: string;
  },
): Promise<CommandChatMessage | null> {
  const [existing] = await db
    .select({
      fingerprint: chatCommandIdempotency.fingerprint,
      result: chatCommandIdempotency.result,
    })
    .from(chatCommandIdempotency)
    .where(
      and(
        eq(chatCommandIdempotency.actorId, actorId),
        eq(chatCommandIdempotency.commandType, commandType),
        eq(chatCommandIdempotency.idempotencyKey, idempotencyKey),
      ),
    );

  if (!existing) {
    return null;
  }
  if (existing.fingerprint !== fingerprint) {
    throw new ChatCommandIdempotencyKeyReuseError();
  }
  if (!existing.result) {
    throw new ConcurrentCommandReplayError();
  }
  return existing.result;
}

async function completeDurableCommand(
  tx: DrizzleTx,
  id: Uuid,
  result: CommandChatMessage,
): Promise<void> {
  await tx.update(chatCommandIdempotency).set({ result }).where(eq(chatCommandIdempotency.id, id));
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

// Translates a thrown domain error into the GIFT_COMMANDS port's discriminated
// result so chat-commands never needs to import this module's error classes
// (module boundary) - only genuinely unexpected errors still throw across the
// port. `.name`-based fallback covers an error surfacing from CHAT_ROOM_ACCESS
// (a different module's class), mirroring the sender-side room-access guard.
function toSendGiftResult(error: unknown): SendGiftResult {
  if (error instanceof CommandDisabledError) {
    return { ok: false, reason: 'disabled' };
  }
  if (error instanceof InsufficientBalanceError) {
    return { ok: false, reason: 'insufficient_balance' };
  }
  if (error instanceof ExceedsLimitError) {
    return { ok: false, reason: 'exceeds_limit' };
  }
  if (error instanceof BelowMinimumError) {
    return { ok: false, reason: 'below_minimum' };
  }
  if (error instanceof ChatPlayerNotFoundError) {
    return { ok: false, reason: 'player_not_found', playerId: error.playerId };
  }
  if (error instanceof ChatCommandIdempotencyKeyReuseError) {
    return { ok: false, reason: 'idempotency_key_reuse' };
  }
  if (error instanceof ConcurrentCommandReplayError) {
    return { ok: false, reason: 'concurrent_replay' };
  }
  if (
    error instanceof ChatRoomNotMemberError ||
    (error instanceof Error && error.name === 'ChatRoomNotMemberError')
  ) {
    return { ok: false, reason: 'room_not_member' };
  }
  throw error;
}

function toClaimGiftResult(error: unknown): ClaimGiftResult {
  if (error instanceof GiftNotFoundError) {
    return { ok: false, reason: 'gift_not_found' };
  }
  if (error instanceof GiftAlreadyClaimedError) {
    return { ok: false, reason: 'already_claimed' };
  }
  if (error instanceof GiftSelfClaimError) {
    return { ok: false, reason: 'self_claim' };
  }
  if (error instanceof BlockedRecipientError) {
    return { ok: false, reason: 'blocked_recipient' };
  }
  if (error instanceof GiftRoomAccessError) {
    return { ok: false, reason: 'room_not_member', roomId: error.roomId };
  }
  if (error instanceof GiftCreditError) {
    return { ok: false, reason: 'gift_credit_failed' };
  }
  throw error;
}

function toGetGiftResult(error: unknown): GetGiftResult {
  if (error instanceof GiftNotFoundError) {
    return { ok: false, reason: 'gift_not_found' };
  }
  if (error instanceof GiftRoomAccessError) {
    return { ok: false, reason: 'room_not_member', roomId: error.roomId };
  }
  throw error;
}

function toSendRainResult(error: unknown): SendRainResult {
  if (error instanceof CommandDisabledError) {
    return { ok: false, reason: 'disabled' };
  }
  if (error instanceof InsufficientBalanceError) {
    return { ok: false, reason: 'insufficient_balance' };
  }
  if (error instanceof ExceedsLimitError) {
    return { ok: false, reason: 'exceeds_limit' };
  }
  if (error instanceof BelowMinimumError) {
    return { ok: false, reason: 'below_minimum' };
  }
  if (error instanceof ChatPlayerNotFoundError) {
    return { ok: false, reason: 'player_not_found', playerId: error.playerId };
  }
  if (error instanceof NoOnlineUsersError) {
    return { ok: false, reason: 'no_online_users' };
  }
  if (error instanceof TooManyRecipientsError) {
    return { ok: false, reason: 'too_many_recipients' };
  }
  if (error instanceof RainCreditError) {
    return { ok: false, reason: 'rain_credit_failed' };
  }
  if (error instanceof ChatCommandIdempotencyKeyReuseError) {
    return { ok: false, reason: 'idempotency_key_reuse' };
  }
  if (error instanceof ConcurrentCommandReplayError) {
    return { ok: false, reason: 'concurrent_replay' };
  }
  if (
    error instanceof ChatRoomNotMemberError ||
    (error instanceof Error && error.name === 'ChatRoomNotMemberError')
  ) {
    return { ok: false, reason: 'room_not_member' };
  }
  throw error;
}

export class ChatCommandTransfersService implements GiftCommands, RainCommands {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly systemWriter: ChatSystemWriter,
    private readonly wallet: WalletCommands,
    private readonly directory: AdminUserDirectory,
    private readonly audit: AuditWritePort,
    private readonly transport: RealtimeTransport,
    private readonly events: EventBus,
    private readonly roomAccess: ChatRoomAccess,
    private readonly blockWriter: ChatBlockWriter,
    private readonly cache: CacheAdapter,
    private readonly idempotencyTtlMs = COMMAND_IDEMPOTENCY_TTL_MS,
  ) {}

  // GIFT_COMMANDS port impl, consumed by chat-commands via DI - never throws,
  // every failure the caller must distinguish comes back as a typed `reason`.
  async sendGift(input: SendGiftArgs, actorId: Uuid): Promise<SendGiftResult> {
    try {
      const message = await this.doSendGift(input, actorId);
      return { ok: true, message };
    } catch (error) {
      return toSendGiftResult(error);
    }
  }

  async claimGift(giftId: Uuid, claimerId: Uuid): Promise<ClaimGiftResult> {
    try {
      return await this.doClaimGift(giftId, claimerId);
    } catch (error) {
      return toClaimGiftResult(error);
    }
  }

  async getGift(giftId: Uuid, viewerId: Uuid): Promise<GetGiftResult> {
    try {
      const gift = await this.doGetGift(giftId, viewerId);
      return { ok: true, gift };
    } catch (error) {
      return toGetGiftResult(error);
    }
  }

  // RAIN_COMMANDS port impl, consumed by chat-commands via DI - never throws.
  // `input.onlineUserIds` is resolved by the caller (chat-commands owns
  // presence via its own dependency on `chat`); this module never queries
  // online status itself.
  async sendRain(input: SendRainArgs, actorId: Uuid): Promise<SendRainResult> {
    try {
      const message = await this.doSendRain(input, actorId);
      return { ok: true, message };
    } catch (error) {
      return toSendRainResult(error);
    }
  }

  async sendDonate(input: SendDonateInput, actorId: Uuid): Promise<CommandChatMessage> {
    return this.doSendDonate(input, actorId);
  }

  private async loadCommandConfig(key: 'gift' | 'rain' | 'donate') {
    const [row] = await this.drizzle.db
      .select()
      .from(chatCommandConfig)
      .where(eq(chatCommandConfig.key, key))
      .limit(1);
    if (!row || !row.enabled) {
      throw new CommandDisabledError(key);
    }
    return row.config ?? null;
  }

  private async verifyRoomAccessIfNeeded(roomId: Uuid | null, actorId: Uuid): Promise<void> {
    if (!roomId) {
      return;
    }
    try {
      await this.roomAccess.verifyRoomAccess(roomId, actorId);
    } catch (error) {
      if (error instanceof Error && error.name === 'ChatRoomNotMemberError') {
        throw new ChatRoomNotMemberError(roomId);
      }
      throw error;
    }
  }

  private async findCommandReplay(
    commandType: 'gift' | 'rain' | 'donate',
    actorId: Uuid,
    idempotencyKey: Uuid,
    fingerprint: string,
  ): Promise<CommandChatMessage | null> {
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
    result: CommandChatMessage,
  ): Promise<void> {
    try {
      await this.cache.set(
        this.idempotencyCacheKey(commandType, actorId, idempotencyKey),
        { fingerprint, result } satisfies CommandIdempotencyRecord,
        { ttlMs: this.idempotencyTtlMs },
      );
    } catch (err) {
      logger.error(
        { err, commandType, actorId, idempotencyKey },
        'idempotency result cache failed',
      );
    }
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
      try {
        await this.cache.delete(this.idempotencyCacheKey(commandType, actorId, idempotencyKey));
      } catch (cleanupError) {
        logger.error(
          { err: cleanupError, commandType, actorId, idempotencyKey },
          'idempotency reservation cleanup failed',
        );
      }
      throw error;
    }
  }

  // Exact, case-insensitive username resolution for callers holding a complete, already-known
  // username (never a partial search term) - `/donate`. Distinct from findPlayerIds' capped
  // fuzzy substring search, which can silently drop the real match once more than 20 unrelated
  // accounts substring-collide with a short/common username.
  private async resolveExactPlayer(username: string) {
    const summary = await this.directory.getPlayerByUsername(username);
    if (!summary) {
      throw new ChatPlayerNotFoundError(username);
    }
    return summary;
  }

  private async doSendGift(input: GiftArgs, actorId: Uuid): Promise<CommandChatMessage> {
    await this.verifyRoomAccessIfNeeded(input.roomId, actorId);
    const config = await this.loadCommandConfig('gift');
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

    const fingerprint = fingerprintCommand({ type: 'gift', ...input });
    const replay = await this.findCommandReplay('gift', actorId, input.idempotencyKey, fingerprint);
    if (replay) {
      return replay;
    }
    const durableReplay = await findDurableCommandReplay(this.drizzle.db, {
      commandType: 'gift',
      actorId,
      idempotencyKey: input.idempotencyKey,
      fingerprint,
    });
    if (durableReplay) {
      return durableReplay;
    }

    const senderSummaries = await this.directory.lookupPlayers([actorId]);
    const senderSummary = senderSummaries.find((s) => s.userId === actorId);
    if (!senderSummary) {
      throw new ChatPlayerNotFoundError(actorId);
    }
    const senderUsername = senderSummary.username;

    // Sender resolved BEFORE reserving: runWithCommandReservation only releases the
    // reservation on a failure inside its own callback, so anything between reserveCommandIdempotency
    // and that callback would otherwise leak a stuck reservation for the full TTL.
    await this.reserveCommandIdempotency('gift', actorId, input.idempotencyKey, fingerprint);

    const { msg, giftId, currency, replayed } = await this.runWithCommandReservation(
      'gift',
      actorId,
      input.idempotencyKey,
      () =>
        this.drizzle.db.transaction(async (tx) => {
          const command = await claimDurableCommand(tx, {
            commandType: 'gift',
            actorId,
            idempotencyKey: input.idempotencyKey,
            fingerprint,
          });
          if (command.replay) {
            return {
              msg: command.replay,
              giftId: undefined,
              currency: undefined,
              replayed: true as const,
            };
          }

          const debit = await this.wallet.debit(tx, {
            userId: actorId,
            amount: input.amount,
            type: 'gift',
          });
          if (!debit.ok) {
            throw new InsufficientBalanceError();
          }

          const [giftRow] = await tx
            .insert(playerGift)
            .values({
              senderId: actorId,
              senderUsername,
              amount: input.amount,
              currency: debit.currency,
              roomId: input.roomId,
              // messageId is back-filled below, in the same transaction, once the
              // system message exists (same insert-then-update pattern as before).
              messageId: '00000000-0000-0000-0000-000000000000',
            })
            .returning();

          if (!giftRow) {
            throw new InsufficientBalanceError();
          }

          const message = await this.systemWriter.postSystemMessage({
            roomId: input.roomId,
            actorId,
            tx,
            username: senderUsername,
            metadata: {
              command: 'gift',
              giftId: giftRow.id,
              senderId: actorId,
              senderUsername,
              amount: input.amount,
              currency: debit.currency,
              status: 'available',
              claimedBy: null,
              claimedByUsername: null,
              claimedAt: null,
            },
          });

          await tx
            .update(playerGift)
            .set({ messageId: message.id })
            .where(eq(playerGift.id, giftRow.id));

          await this.audit.recordInTransaction(tx, {
            actorId,
            actorType: 'player',
            action: 'chat.gift',
            resourceType: 'player_gift',
            resourceId: giftRow.id,
            before: null,
            after: { amount: input.amount, roomId: input.roomId },
          });
          await completeDurableCommand(tx, command.id, message);

          return {
            msg: message,
            giftId: giftRow.id,
            currency: debit.currency,
            replayed: false as const,
          };
        }),
    );
    if (replayed) {
      return msg;
    }
    await this.completeCommandIdempotency('gift', actorId, input.idempotencyKey, fingerprint, msg);

    // The caller now owns the commit boundary: postSystemMessage was passed `tx` above so
    // it did not auto-publish - publish only now that this transaction has committed.
    publishChatEvent(this.transport, input.roomId, msg);

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

  private async doClaimGift(giftId: Uuid, claimerId: Uuid): Promise<ClaimGiftResult> {
    const claimerSummaries = await this.directory.lookupPlayers([claimerId]);
    const claimerSummary = claimerSummaries.find((s) => s.userId === claimerId);
    if (!claimerSummary) {
      throw new GiftNotFoundError(claimerId);
    }
    const claimerUsername = claimerSummary.username;

    const { claimed, currency, roomId, senderId, message } = await this.drizzle.db.transaction(
      async (tx) => {
        // FOR UPDATE serializes concurrent claims against the same gift row under READ COMMITTED.
        const giftRow = findOneOrThrow(
          await tx.select().from(playerGift).where(eq(playerGift.id, giftId)).for('update'),
          new GiftNotFoundError(giftId),
        );

        try {
          await this.verifyRoomAccessIfNeeded(giftRow.roomId, claimerId);
        } catch (error) {
          if (error instanceof Error && error.name === 'ChatRoomNotMemberError') {
            throw new GiftRoomAccessError(giftRow.roomId);
          }
          throw error;
        }

        if (giftRow.senderId === claimerId) {
          throw new GiftSelfClaimError();
        }
        if (await this.blockWriter.isBlocked(tx, giftRow.senderId, claimerId)) {
          throw new BlockedRecipientError();
        }
        if (giftRow.claimedBy) {
          throw new GiftAlreadyClaimedError();
        }

        const claimedAt = new Date();
        // Guarded conditional update: WHERE claimed_by IS NULL stays as defense-in-depth
        // alongside the row lock above (same pattern as wallet's guarded debit).
        const results = await tx
          .update(playerGift)
          .set({ claimedBy: claimerId, claimedByUsername: claimerUsername, claimedAt })
          .where(and(eq(playerGift.id, giftId), isNull(playerGift.claimedBy)))
          .returning();

        const updated = findOneOrThrow(results, new GiftAlreadyClaimedError());

        const credit = await this.wallet.credit(tx, {
          userId: claimerId,
          amount: updated.amount,
          currency: updated.currency,
          type: 'gift',
        });
        if (!credit.ok) {
          throw new GiftCreditError();
        }

        await this.audit.recordInTransaction(tx, {
          actorId: claimerId,
          actorType: 'player',
          action: 'chat.gift.claimed',
          resourceType: 'player_gift',
          resourceId: giftId,
          before: null,
          after: { claimedBy: claimerId, amount: updated.amount },
        });

        const updatedMessage = await this.systemWriter.updateSystemMessage({
          messageId: giftRow.messageId,
          tx,
          metadata: {
            command: 'gift',
            giftId: giftRow.id,
            senderId: giftRow.senderId,
            senderUsername: giftRow.senderUsername,
            amount: giftRow.amount,
            currency: updated.currency,
            status: 'claimed',
            claimedBy: claimerId,
            claimedByUsername: claimerUsername,
            claimedAt: claimedAt.toISOString(),
          },
        });

        return {
          claimed: updated,
          currency: updated.currency,
          roomId: updated.roomId,
          senderId: giftRow.senderId,
          message: updatedMessage,
        };
      },
    );

    const claimedAtIso = claimed.claimedAt?.toISOString() ?? new Date().toISOString();

    publishChatEvent(this.transport, roomId, message);

    void this.events.emit('chat.gift.claimed', {
      giftId,
      claimerId,
      claimerUsername,
      senderId,
      amount: claimed.amount,
      currency,
      roomId,
    });

    return {
      ok: true,
      claimedBy: claimerId,
      claimedByUsername: claimerUsername,
      claimedAt: claimedAtIso,
    };
  }

  private async doGetGift(giftId: Uuid, viewerId: Uuid): Promise<GiftSnapshot> {
    const rows = await this.drizzle.db.select().from(playerGift).where(eq(playerGift.id, giftId));
    const giftRow = findOneOrThrow(rows, new GiftNotFoundError(giftId));

    // Same room-membership boundary as doClaimGift: a viewer must be a member
    // of the gift's room to poll its status. No FOR UPDATE - read-only, no
    // mutation, no need to serialize against concurrent claims.
    try {
      await this.verifyRoomAccessIfNeeded(giftRow.roomId, viewerId);
    } catch (error) {
      if (error instanceof Error && error.name === 'ChatRoomNotMemberError') {
        throw new GiftRoomAccessError(giftRow.roomId);
      }
      throw error;
    }

    return {
      id: giftRow.id,
      senderId: giftRow.senderId,
      senderUsername: giftRow.senderUsername,
      amount: giftRow.amount,
      currency: giftRow.currency,
      claimedBy: giftRow.claimedBy,
      claimedByUsername: giftRow.claimedByUsername,
      claimedAt: giftRow.claimedAt ? giftRow.claimedAt.toISOString() : null,
      createdAt: giftRow.createdAt.toISOString(),
    };
  }

  private async doSendRain(input: SendRainArgs, actorId: Uuid): Promise<CommandChatMessage> {
    await this.verifyRoomAccessIfNeeded(input.roomId, actorId);
    const config = await this.loadCommandConfig('rain');
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
    const fingerprint = fingerprintCommand({ type: 'rain', ...input });
    const replay = await this.findCommandReplay('rain', actorId, input.idempotencyKey, fingerprint);
    if (replay) {
      return replay;
    }
    const durableReplay = await findDurableCommandReplay(this.drizzle.db, {
      commandType: 'rain',
      actorId,
      idempotencyKey: input.idempotencyKey,
      fingerprint,
    });
    if (durableReplay) {
      return durableReplay;
    }

    const senderSummaries = await this.directory.lookupPlayers([actorId]);
    const sender = senderSummaries.find((s) => s.userId === actorId);
    if (!sender) {
      throw new ChatPlayerNotFoundError(actorId);
    }
    await this.reserveCommandIdempotency('rain', actorId, input.idempotencyKey, fingerprint);

    // Recipients resolved INSIDE runWithCommandReservation's callback (unlike doSendGift's
    // pre-reservation directory lookup): runWithCommandReservation only releases the reservation
    // on a failure inside its own callback, so throwing NoOnlineUsersError here - after
    // reserveCommandIdempotency but before the callback - would otherwise leak a stuck reservation
    // for the full TTL. It must also stay after findCommandReplay/reserveCommandIdempotency so a
    // replay with a now-empty onlineUserIds list (the caller retried after everyone left) still
    // returns the original stored result instead of a spurious NoOnlineUsersError.
    const { msg, currency, totalDistributed, recipientIds, replayed } =
      await this.runWithCommandReservation('rain', actorId, input.idempotencyKey, async () => {
        const recipients = shuffleArray(input.onlineUserIds.filter((id) => id !== actorId)).slice(
          0,
          input.recipientCount,
        );
        if (recipients.length === 0) {
          throw new NoOnlineUsersError();
        }
        const recipientSummaries = await this.directory.lookupPlayers(recipients);
        const recipientDetails = recipients.map((recipientId) => {
          const summary = recipientSummaries.find((s) => s.userId === recipientId);
          if (!summary) {
            throw new ChatPlayerNotFoundError(recipientId);
          }
          return { userId: summary.userId, username: summary.username };
        });
        return this.drizzle.db.transaction(async (tx) => {
          const command = await claimDurableCommand(tx, {
            commandType: 'rain',
            actorId,
            idempotencyKey: input.idempotencyKey,
            fingerprint,
          });
          if (command.replay) {
            return {
              msg: command.replay,
              currency: undefined,
              totalDistributed: undefined,
              recipientIds: undefined,
              replayed: true as const,
            };
          }

          const { perRecipient, totalDistributed } = await calculateRainSplit(
            tx,
            input.amount,
            input.recipientCount,
            recipients.length,
          );
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

          const [rainRow] = await tx
            .insert(playerRain)
            .values({
              senderId: actorId,
              amount: totalDistributed,
              perRecipient,
              currency: debit.currency,
              roomId: input.roomId,
              recipientCount: recipients.length,
            })
            .returning();
          if (!rainRow) {
            throw new RainCreditError();
          }
          await tx.insert(playerRainReceiver).values(
            recipients.map((recipientId) => ({
              rainId: rainRow.id,
              recipientId,
              amount: perRecipient,
            })),
          );

          const message = await this.systemWriter.postSystemMessage({
            roomId: input.roomId,
            actorId,
            tx,
            username: sender.username,
            metadata: {
              command: 'rain',
              fromUserId: actorId,
              fromUsername: sender.username,
              amount: totalDistributed,
              currency: debit.currency,
              recipientCount: recipients.length,
              perRecipient,
              recipients: recipientDetails,
            },
          });

          await this.audit.recordInTransaction(tx, {
            actorId,
            actorType: 'player',
            action: 'chat.rain',
            resourceType: 'player_rain',
            resourceId: rainRow.id,
            before: null,
            after: { amount: totalDistributed, recipientCount: recipients.length },
          });
          await completeDurableCommand(tx, command.id, message);

          return {
            msg: message,
            currency: debit.currency,
            totalDistributed,
            perRecipient,
            recipientIds: recipients,
            replayed: false as const,
          };
        });
      });
    if (replayed) {
      return msg;
    }
    await this.completeCommandIdempotency('rain', actorId, input.idempotencyKey, fingerprint, msg);

    // The caller now owns the commit boundary: postSystemMessage was passed `tx` above so
    // it did not auto-publish - publish only now that this transaction has committed.
    publishChatEvent(this.transport, input.roomId, msg);

    void this.events.emit('chat.rain.distributed', {
      fromUserId: actorId,
      recipients: recipientIds,
      recipientCount: recipientIds.length,
      totalAmount: totalDistributed,
      currency,
      roomId: input.roomId,
    });
    return msg;
  }

  private async doSendDonate(input: DonateArgs, actorId: Uuid): Promise<CommandChatMessage> {
    await this.verifyRoomAccessIfNeeded(input.roomId, actorId);
    const config = await this.loadCommandConfig('donate');
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

    const fingerprint = fingerprintCommand({ type: 'donate', ...input });
    const replay = await this.findCommandReplay(
      'donate',
      actorId,
      input.idempotencyKey,
      fingerprint,
    );
    if (replay) {
      return replay;
    }
    const durableReplay = await findDurableCommandReplay(this.drizzle.db, {
      commandType: 'donate',
      actorId,
      idempotencyKey: input.idempotencyKey,
      fingerprint,
    });
    if (durableReplay) {
      return durableReplay;
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
    await this.reserveCommandIdempotency('donate', actorId, input.idempotencyKey, fingerprint);

    const { msg, currency, replayed } = await this.runWithCommandReservation(
      'donate',
      actorId,
      input.idempotencyKey,
      () =>
        this.drizzle.db.transaction(async (tx) => {
          const command = await claimDurableCommand(tx, {
            commandType: 'donate',
            actorId,
            idempotencyKey: input.idempotencyKey,
            fingerprint,
          });
          if (command.replay) {
            return { msg: command.replay, currency: undefined, replayed: true as const };
          }

          if (await this.blockWriter.isBlocked(tx, actorId, target.userId)) {
            throw new BlockedRecipientError();
          }
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

          const message = await this.systemWriter.postSystemMessage({
            roomId: input.roomId,
            actorId,
            tx,
            username: sender.username,
            metadata: {
              command: 'donate',
              senderId: actorId,
              senderUsername: sender.username,
              recipientId: target.userId,
              recipientUsername: target.username,
              amount: input.amount,
              currency: debit.currency,
            },
          });

          const [donateRow] = await tx
            .insert(playerDonate)
            .values({
              senderId: actorId,
              senderUsername: sender.username,
              recipientId: target.userId,
              recipientUsername: target.username,
              amount: input.amount,
              currency: debit.currency,
              roomId: input.roomId,
            })
            .returning();
          if (!donateRow) {
            throw new ChatPlayerNotFoundError(target.userId);
          }

          await this.audit.recordInTransaction(tx, {
            actorId,
            actorType: 'player',
            action: 'chat.donate',
            resourceType: 'player_donate',
            resourceId: donateRow.id,
            before: null,
            after: { recipientId: target.userId, amount: input.amount, currency: debit.currency },
          });
          await completeDurableCommand(tx, command.id, message);

          return { msg: message, currency: debit.currency, replayed: false as const };
        }),
    );
    if (replayed) {
      return msg;
    }
    await this.completeCommandIdempotency(
      'donate',
      actorId,
      input.idempotencyKey,
      fingerprint,
      msg,
    );

    publishChatEvent(this.transport, input.roomId, msg);

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
}

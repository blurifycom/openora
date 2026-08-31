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
import { chatChannel, MONEY_SCALE } from '@openora/core/contracts';
import { chatCommandConfig } from '@openora/core/engagement/schema/chat-commands';
import {
  CommandConfigSchema,
  type CommandConfig,
} from '@openora/core/engagement/contracts/chat-commands';
import type { SendDonateInput } from '../contract/index.js';
import { playerGift, playerDonate, playerRain, playerRainReceiver } from '../schema/index.js';

const logger = createLogger('social-transfers');

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
  'Amount too small: the per-recipient split would round down to zero',
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

type GiftArgs = { amount: string; currency?: string; roomId: Uuid | null; idempotencyKey: Uuid };
type RainFingerprintArgs = Pick<
  SendRainArgs,
  'amount' | 'currency' | 'recipientCount' | 'roomId' | 'idempotencyKey'
>;
type DonateArgs = {
  targetUsername: string;
  amount: string;
  currency?: string;
  roomId: Uuid | null;
  idempotencyKey: Uuid;
};
type MoneyMovingInput =
  | ({ type: 'gift' } & GiftArgs)
  | ({ type: 'rain' } & RainFingerprintArgs)
  | ({ type: 'donate' } & DonateArgs);

// Floors to the platform's own stored precision (MONEY_SCALE, `numeric(38,18)` - the
// smallest unit any currency here is ever persisted at), not a hardcoded two-decimal
// ("cents") step. Flooring to cents was fine for fiat but wrong for an 18-decimal crypto
// currency: a legitimate sub-cent split (eg BTC) would floor to zero every time and
// wrongly report `TooManyRecipientsError`. Flooring at MONEY_SCALE works identically for
// every currency without needing a per-currency decimals table - see this module's
// AGENTS.md.
// Shifts an exact integer-unit string (smallest unit at MONEY_SCALE, eg "wei"/"satoshi"-like)
// back into a MONEY_SCALE-decimal string via plain string slicing - never numeric division.
// Postgres' `numeric / numeric` targets a fixed number of SIGNIFICANT digits (its own
// heuristic, independent of MONEY_SCALE), not a fixed number of DECIMAL digits - dividing an
// exact integer by a power of ten can still silently round away trailing digits before this
// value ever reaches JS. A string insert of the decimal point MONEY_SCALE digits from the
// right is exact by construction and needs no numeric arithmetic at all.
function unitsToDecimalString(units: string): string {
  const padded = units.padStart(MONEY_SCALE + 1, '0');
  const integerPart = padded.slice(0, -MONEY_SCALE) || '0';
  const fractionPart = padded.slice(-MONEY_SCALE);
  return `${integerPart}.${fractionPart}`;
}

export async function calculateRainSplit(
  tx: DrizzleTx,
  amount: string,
  requestedRecipientCount: number,
  actualRecipientCount: number,
): Promise<{ perRecipient: string; totalDistributed: string }> {
  // A literal scale factor ('1' followed by MONEY_SCALE zeros), not Postgres' `^` operator:
  // `numeric ^ numeric` loses trailing digits of precision on an 18-zero exponent, which
  // would silently truncate the very precision this function exists to preserve.
  const scaleFactor = `1${'0'.repeat(MONEY_SCALE)}`;
  // `floor(a::numeric / b)` is NOT exact for a non-terminating quotient (eg 44.44/3): numeric
  // division itself computes a fixed number of significant digits BEFORE floor() ever sees
  // the result, silently truncating the very precision this function exists to preserve. MOD
  // is exact regardless of magnitude (it targets an explicit integer quotient internally, not
  // a significant-digit estimate), so `scaledAmount - MOD(scaledAmount, count)` is an EXACT
  // multiple of `count`, and dividing that exact multiple by `count` terminates with a zero
  // remainder - an exact integer, not an estimate. Both results below stay in this exact
  // integer-of-the-smallest-unit form; `unitsToDecimalString` does the (equally exact) decimal
  // shift back in JS, never through a second lossy numeric division.
  const splitResult = await tx.execute(
    sql`WITH scaled AS (
      SELECT ${amount}::numeric * ${scaleFactor}::numeric AS total_units
    ), floored AS (
      SELECT (total_units - MOD(total_units, ${requestedRecipientCount})) / ${requestedRecipientCount} AS per_recipient_units
      FROM scaled
    )
    SELECT
      trunc(per_recipient_units)::text AS per_recipient_units,
      trunc(per_recipient_units * ${actualRecipientCount})::text AS total_distributed_units,
      (per_recipient_units > 0) AS has_positive_recipient
    FROM floored`,
  );
  const {
    per_recipient_units: perRecipientUnits,
    total_distributed_units: totalDistributedUnits,
    has_positive_recipient: hasPositiveRecipient,
  } = splitResult.rows[0] as {
    per_recipient_units: string;
    total_distributed_units: string;
    has_positive_recipient: boolean;
  };
  if (!hasPositiveRecipient) {
    throw new TooManyRecipientsError();
  }
  return {
    perRecipient: unitsToDecimalString(perRecipientUnits),
    totalDistributed: unitsToDecimalString(totalDistributedUnits),
  };
}

const DEFAULT_RAIN_MAX_RECIPIENTS = 100;

const COMMAND_IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;
type CommandIdempotencyRecord = {
  fingerprint: string;
  result: CommandChatMessage | null;
};

// The replay guard must match on the COMPLETE request, not just the amount - a reused
// key with a different room, recipient count, donate target, OR CURRENCY is a distinct
// request, not a replay of the original (a replay must never let a caller quietly swap
// which balance gets debited by resubmitting with a different `currency`).
// `idempotencyKey` itself is excluded so the fingerprint is stable for the row it guards.
// The cache-key namespace stays `chat-command:*` even though this logic now lives here -
// see AGENTS.md.
export function fingerprintCommand(input: MoneyMovingInput): string {
  const canonical: Record<string, unknown> =
    input.type === 'gift'
      ? { type: input.type, amount: input.amount, currency: input.currency, roomId: input.roomId }
      : input.type === 'rain'
        ? {
            type: input.type,
            amount: input.amount,
            currency: input.currency,
            recipientCount: input.recipientCount,
            roomId: input.roomId,
          }
        : {
            type: input.type,
            amount: input.amount,
            currency: input.currency,
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

export class SocialTransfersService implements GiftCommands, RainCommands {
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

  private async loadCommandConfig(key: 'gift' | 'rain' | 'donate'): Promise<CommandConfig | null> {
    const [row] = await this.drizzle.db
      .select()
      .from(chatCommandConfig)
      .where(eq(chatCommandConfig.key, key))
      .limit(1);
    if (!row || !row.enabled) {
      throw new CommandDisabledError(key);
    }
    if (row.config === null) {
      return null;
    }
    // `chatCommandConfig.config` is only typed via Drizzle's `$type<CommandConfig>()`, never
    // runtime-checked - a row written before CommandConfigSchema's minAmount/maxAmount became
    // per-currency maps (a flat `{ minAmount: '5.00000000' }`) would otherwise reach
    // `assertWithinCommandLimits` unvalidated, where indexing a string by a currency key
    // silently returns undefined and the limit is treated as "not configured" rather than
    // flagged. Parse it for real so a shape mismatch is visible in logs instead of silently
    // degrading a real-money spend limit to unlimited.
    const parsed = CommandConfigSchema.safeParse(row.config);
    if (!parsed.success) {
      logger.error(
        { key, config: row.config, issues: parsed.error.issues },
        'chat_command_config row does not match CommandConfigSchema - treating as unconfigured',
      );
      return null;
    }
    return parsed.data;
  }

  // Config's minAmount/maxAmount are keyed by currency (chat-commands' CommandConfigSchema) -
  // a currency with no entry has no limit enforced for it. This can only run once the
  // ACTUAL debited currency is known: when the caller omits `currency`, that is whichever
  // currency the sender's active balance turns out to be, which is only resolved inside the
  // wallet debit itself. So this always runs AFTER `wallet.debit` succeeds, inside the same
  // transaction - a violation throws and rolls the debit back with everything else.
  private assertWithinCommandLimits(
    config: CommandConfig | null,
    currency: string,
    amount: string,
  ): void {
    const max = config?.maxAmount?.[currency];
    if (max !== undefined && moneyToNumber(amount) > moneyToNumber(max)) {
      throw new ExceedsLimitError();
    }
    const min = config?.minAmount?.[currency];
    if (min !== undefined && moneyToNumber(amount) < moneyToNumber(min)) {
      throw new BelowMinimumError();
    }
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

    const senderSummaries = await this.directory.lookupPlayers([actorId]);
    const senderSummary = senderSummaries.find((s) => s.userId === actorId);
    if (!senderSummary) {
      throw new ChatPlayerNotFoundError(actorId);
    }
    const senderUsername = senderSummary.username;

    // Sender resolved BEFORE reserving (mirrors doSendDonate): runWithCommandReservation
    // only releases the reservation on a failure inside its own callback, so anything
    // between reserveCommandIdempotency and that callback would otherwise leak a stuck
    // reservation for the full TTL on a transient directory error.
    const fingerprint = fingerprintCommand({ type: 'gift', ...input });
    const replay = await this.findCommandReplay('gift', actorId, input.idempotencyKey, fingerprint);
    if (replay) {
      return replay;
    }
    await this.reserveCommandIdempotency('gift', actorId, input.idempotencyKey, fingerprint);

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
            currency: input.currency,
          });
          if (!debit.ok) {
            throw new InsufficientBalanceError();
          }
          this.assertWithinCommandLimits(config, debit.currency, input.amount);

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
            after: { amount: input.amount, currency: debit.currency, roomId: input.roomId },
          });

          return { msg: message, giftId: giftRow.id, currency: debit.currency };
        }),
    );
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

        // Credits the GIFT'S OWN stored currency, never the claimer's current active one -
        // `allowNewCurrency` creates the claimer's balance row for it if they have never
        // held it before, since that is the ordinary case for a gift, not a caller bug.
        // `allowNewWallet` covers the claimer who has never deposited and so has no wallet
        // row at all - refusing them would strand a gift the sender is already debited for.
        const credit = await this.wallet.credit(tx, {
          userId: claimerId,
          amount: updated.amount,
          currency: updated.currency,
          type: 'gift',
          allowNewCurrency: true,
          allowNewWallet: true,
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
          after: { claimedBy: claimerId, amount: updated.amount, currency: updated.currency },
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

    // 100 is the platform default an operator overrides downward per room, not a hard
    // ceiling - it matches the recipient range the /rain command surface advertises.
    const configMax = config?.maxRecipients ?? DEFAULT_RAIN_MAX_RECIPIENTS;
    if (input.recipientCount > configMax) {
      throw new ExceedsLimitError();
    }
    const senderSummaries = await this.directory.lookupPlayers([actorId]);
    const sender = senderSummaries.find((s) => s.userId === actorId);
    if (!sender) {
      throw new ChatPlayerNotFoundError(actorId);
    }
    const fingerprint = fingerprintCommand({ type: 'rain', ...input });
    const replay = await this.findCommandReplay('rain', actorId, input.idempotencyKey, fingerprint);
    if (replay) {
      return replay;
    }
    await this.reserveCommandIdempotency('rain', actorId, input.idempotencyKey, fingerprint);

    // Recipients resolved INSIDE runWithCommandReservation's callback (unlike doSendGift's
    // pre-reservation directory lookup): runWithCommandReservation only releases the reservation
    // on a failure inside its own callback, so throwing NoOnlineUsersError here - after
    // reserveCommandIdempotency but before the callback - would otherwise leak a stuck reservation
    // for the full TTL. It must also stay after findCommandReplay/reserveCommandIdempotency so a
    // replay with a now-empty onlineUserIds list (the caller retried after everyone left) still
    // returns the original stored result instead of a spurious NoOnlineUsersError.
    const { msg, currency, totalDistributed, recipientIds } = await this.runWithCommandReservation(
      'rain',
      actorId,
      input.idempotencyKey,
      async () => {
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
            currency: input.currency,
          });
          if (!debit.ok) {
            throw new InsufficientBalanceError();
          }
          // Pre-transaction maxAmount/minAmount still validate against the player-typed
          // `input.amount`, not `totalDistributed` - see AGENTS.md "Rain has a remainder".
          this.assertWithinCommandLimits(config, debit.currency, input.amount);
          // Every recipient is credited in the SAME currency the sender was debited in -
          // `allowNewCurrency` opens a balance row for a recipient who has never held it,
          // which is the ordinary case for rain, not a caller bug. `allowNewWallet` does the
          // same for a recipient who has never deposited and so has no wallet row at all:
          // rain picks whoever is online, and one never-funded player in that set would
          // otherwise abort the whole distribution.
          const credits = await mapConcurrent(recipients, 10, (userId) =>
            this.wallet.credit(tx, {
              userId,
              amount: perRecipient,
              currency: debit.currency,
              type: 'rain',
              allowNewCurrency: true,
              allowNewWallet: true,
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
            after: {
              amount: totalDistributed,
              currency: debit.currency,
              recipientCount: recipients.length,
            },
          });

          return {
            msg: message,
            currency: debit.currency,
            totalDistributed,
            perRecipient,
            recipientIds: recipients,
          };
        });
      },
    );
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

    const target = await this.resolveExactPlayer(input.targetUsername);

    if (target.userId === actorId) {
      throw new DonateSelfError();
    }
    const senderSummaries = await this.directory.lookupPlayers([actorId]);
    const sender = senderSummaries.find((s) => s.userId === actorId);
    if (!sender) {
      throw new ChatPlayerNotFoundError(actorId);
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
    await this.reserveCommandIdempotency('donate', actorId, input.idempotencyKey, fingerprint);

    const { msg, currency } = await this.runWithCommandReservation(
      'donate',
      actorId,
      input.idempotencyKey,
      () =>
        this.drizzle.db.transaction(async (tx) => {
          if (await this.blockWriter.isBlocked(tx, actorId, target.userId)) {
            throw new BlockedRecipientError();
          }
          const debit = await this.wallet.debit(tx, {
            userId: actorId,
            amount: input.amount,
            type: 'tip',
            currency: input.currency,
          });
          if (!debit.ok) {
            throw new InsufficientBalanceError();
          }
          this.assertWithinCommandLimits(config, debit.currency, input.amount);

          // Credits the recipient in the SAME currency the sender was debited in -
          // `allowNewCurrency` opens a balance row for a recipient who has never held it,
          // which is the ordinary case for a donate, not a caller bug. `allowNewWallet`
          // covers a recipient who has never deposited and so has no wallet row at all.
          const credit = await this.wallet.credit(tx, {
            userId: target.userId,
            amount: input.amount,
            currency: debit.currency,
            type: 'tip',
            allowNewCurrency: true,
            allowNewWallet: true,
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

          return { msg: message, currency: debit.currency };
        }),
    );
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

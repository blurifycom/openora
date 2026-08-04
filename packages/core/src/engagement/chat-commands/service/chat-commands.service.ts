import { eq } from 'drizzle-orm';
import {
  DrizzleService,
  makeNotFoundError,
  makeConflictError,
  createDomainError,
} from '@openora/core/server';
import type {
  Uuid,
  ChatSystemMessage,
  ChatBlockWriter,
  AdminUserDirectory,
  GiftCommands,
  RainCommands,
  RealtimeTransport,
} from '@openora/core/contracts';
import { chatChannel } from '@openora/core/contracts';
import type {
  ChatCommandDescriptor,
  PostGiftInput,
  PostRainInput,
  ClaimGiftOutput,
} from '../contract/index.js';
import { ChatCommandTypeSchema } from '../contract/index.js';
import { chatCommandConfig } from '../schema/index.js';

export const CommandDisabledError = makeNotFoundError('ChatCommand');
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
export const NoOnlineUsersError = makeConflictError(
  'NoOnlineUsers',
  'No other users are online in this room',
);
export const TooManyRecipientsError = makeConflictError(
  'TooManyRecipients',
  'Amount too small: you need at least $1 per recipient',
);
export const RainCreditError = makeConflictError(
  'RainCreditError',
  'A recipient wallet is unavailable; rain aborted',
);
export const GiftNotFoundError = makeNotFoundError('ChatGift');
export const GiftAlreadyClaimedError = makeConflictError(
  'GiftAlreadyClaimed',
  'This gift has already been claimed',
);
export const GiftSelfClaimError = makeConflictError(
  'GiftSelfClaim',
  'You cannot claim your own gift',
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
    private readonly directory: AdminUserDirectory,
    private readonly blockWriter: ChatBlockWriter,
    private readonly giftCommands: GiftCommands,
    private readonly rainCommands: RainCommands,
    private readonly transport: RealtimeTransport,
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

  async postGift(input: PostGiftInput, actorId: Uuid): Promise<ChatSystemMessage> {
    const result = await this.giftCommands.sendGift(input, actorId);
    if (result.ok) {
      return result.message;
    }
    switch (result.reason) {
      case 'disabled':
        throw new CommandDisabledError('gift');
      case 'insufficient_balance':
        throw new InsufficientBalanceError();
      case 'exceeds_limit':
        throw new ExceedsLimitError();
      case 'below_minimum':
        throw new BelowMinimumError();
      case 'idempotency_key_reuse':
        throw new ChatCommandIdempotencyKeyReuseError();
      case 'concurrent_replay':
        throw new ConcurrentCommandReplayError();
      case 'room_not_member':
        throw new ChatRoomNotMemberError(input.roomId);
    }
  }

  async claimGift(giftId: Uuid, claimerId: Uuid): Promise<ClaimGiftOutput> {
    const result = await this.giftCommands.claimGift(giftId, claimerId);
    if (result.ok) {
      return {
        claimedBy: result.claimedBy,
        claimedByUsername: result.claimedByUsername,
        claimedAt: result.claimedAt,
      };
    }
    switch (result.reason) {
      case 'gift_not_found':
        throw new GiftNotFoundError(giftId);
      case 'already_claimed':
        throw new GiftAlreadyClaimedError();
      case 'self_claim':
        throw new GiftSelfClaimError();
      case 'room_not_member':
        throw new ChatRoomNotMemberError(giftId);
    }
  }

  // Zero rain business logic here - the RAIN_COMMANDS port (bound by
  // social-transfers) owns money movement, limit checks, idempotency, and
  // posting/publishing the resulting chat message. This module only resolves
  // who is online (it owns presence for the whole chat-command surface via
  // its own dependency on `chat`) and translates the port's discriminated
  // result into the typed errors this module's router maps to transport codes.
  async postRain(input: PostRainInput, actorId: Uuid): Promise<ChatSystemMessage> {
    const onlineUserIds = await this.transport.getOnlineUserIds(chatChannel(input.roomId));
    const result = await this.rainCommands.sendRain({ ...input, onlineUserIds }, actorId);
    if (result.ok) {
      return result.message;
    }
    switch (result.reason) {
      case 'disabled':
        throw new CommandDisabledError('rain');
      case 'insufficient_balance':
        throw new InsufficientBalanceError();
      case 'exceeds_limit':
        throw new ExceedsLimitError();
      case 'below_minimum':
        throw new BelowMinimumError();
      case 'no_online_users':
        throw new NoOnlineUsersError();
      case 'too_many_recipients':
        throw new TooManyRecipientsError();
      case 'rain_credit_failed':
        throw new RainCreditError();
      case 'idempotency_key_reuse':
        throw new ChatCommandIdempotencyKeyReuseError();
      case 'concurrent_replay':
        throw new ConcurrentCommandReplayError();
      case 'room_not_member':
        throw new ChatRoomNotMemberError(input.roomId);
    }
  }
}

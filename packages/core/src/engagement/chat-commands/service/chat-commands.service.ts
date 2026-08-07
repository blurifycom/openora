import { eq, asc, desc, count } from 'drizzle-orm';
import {
  DrizzleService,
  makeNotFoundError,
  makeConflictError,
  createDomainError,
  findOneOrThrow,
  pageToOffset,
} from '@openora/core/server';
import type {
  Uuid,
  ChatSystemMessage,
  ChatBlockWriter,
  AdminUserDirectory,
  GiftCommands,
  RainCommands,
  RealtimeTransport,
  AuditWritePort,
} from '@openora/core/contracts';
import { chatChannel } from '@openora/core/contracts';
import type { SortOrder } from '@openora/core/contracts/kit';
import type {
  ChatCommandDescriptor,
  ChatCommandType,
  CommandConfig,
  PostGiftInput,
  PostRainInput,
  ClaimGiftOutput,
  GiftState,
  AdminCommandSortBy,
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
export const GiftCreditError = makeConflictError(
  'GiftCreditError',
  'Recipient wallet is unavailable; gift claim aborted',
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

function toDescriptor(row: typeof chatCommandConfig.$inferSelect): ChatCommandDescriptor {
  return {
    key: ChatCommandTypeSchema.parse(row.key),
    enabled: row.enabled,
    label: row.label,
    description: row.description ?? null,
    config: row.config ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

const ADMIN_COMMAND_SORT_COLUMNS = {
  key: chatCommandConfig.key,
  updatedAt: chatCommandConfig.updatedAt,
} as const satisfies Record<AdminCommandSortBy, unknown>;

export class ChatCommandsService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly directory: AdminUserDirectory,
    private readonly blockWriter: ChatBlockWriter,
    private readonly giftCommands: GiftCommands,
    private readonly rainCommands: RainCommands,
    private readonly transport: RealtimeTransport,
    private readonly audit: AuditWritePort,
  ) {}

  async listCommands(includeDisabled = false): Promise<ChatCommandDescriptor[]> {
    const rows = await this.drizzle.db
      .select()
      .from(chatCommandConfig)
      .where(includeDisabled ? undefined : eq(chatCommandConfig.enabled, true));
    return rows.map(toDescriptor);
  }

  async adminListCommands({
    page,
    limit,
    sortBy,
    sortOrder,
  }: {
    page: number;
    limit: number;
    sortBy: AdminCommandSortBy;
    sortOrder: SortOrder;
  }) {
    const dir = sortOrder === 'asc' ? asc : desc;
    const col = ADMIN_COMMAND_SORT_COLUMNS[sortBy];
    const [rows, [{ n }]] = await Promise.all([
      this.drizzle.db
        .select()
        .from(chatCommandConfig)
        .orderBy(dir(col))
        .limit(limit)
        .offset(pageToOffset(page, limit)),
      this.drizzle.db.select({ n: count() }).from(chatCommandConfig),
    ]);
    return { items: rows.map(toDescriptor), total: Number(n), page, limit };
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
        throw new ChatRoomNotMemberError(result.roomId ?? null);
      case 'gift_credit_failed':
        throw new GiftCreditError();
    }
  }

  async getGift(giftId: Uuid, viewerId: Uuid): Promise<GiftState> {
    const result = await this.giftCommands.getGift(giftId, viewerId);
    if (result.ok) {
      return result.gift;
    }
    switch (result.reason) {
      case 'gift_not_found':
        throw new GiftNotFoundError(giftId);
      case 'room_not_member':
        throw new ChatRoomNotMemberError(result.roomId ?? null);
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

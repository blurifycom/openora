import { eq, sql } from 'drizzle-orm';
import {
  DrizzleService,
  makeNotFoundError,
  makeConflictError,
  mapConcurrent,
  moneyToNumber,
  findOneOrThrow,
  type EventBus,
} from '@openora/core/server';
import type {
  Uuid,
  ChatSystemMessage,
  ChatSystemWriter,
  WalletCommands,
  AdminUserDirectory,
  AuditWritePort,
  RealtimeTransport,
} from '@openora/core/contracts';
import { chatChannel } from '@openora/core/contracts';
import type { ChatCommandDescriptor, ChatCommandType, CommandConfig } from '../contract/index.js';
import { ChatCommandTypeSchema } from '../contract/index.js';
import { chatCommandConfig } from '../schema/index.js';

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
export const RainCreditError = makeConflictError(
  'RainCreditError',
  'A recipient wallet is unavailable; rain aborted',
);
export const ChatPlayerNotFoundError = makeNotFoundError('ChatPlayer');

type ProfileInput = { type: 'profile'; targetUsername: string; roomId: Uuid | null };
type GiftInput = { type: 'gift'; targetUsername: string; amount: string; roomId: Uuid | null };
type RainInput = { type: 'rain'; amount: string; roomId: Uuid };
type ExecuteInput = ProfileInput | GiftInput | RainInput;

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
  ) {}

  async listCommands(includeDisabled = false): Promise<ChatCommandDescriptor[]> {
    const rows = await this.drizzle.db.select().from(chatCommandConfig);
    return rows.filter((r) => includeDisabled || r.enabled).map(toDescriptor);
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
    return this.handleRain(input, actorId, row.config ?? null);
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
    const targetUserId = summary.userId;
    const { msg, currency } = await this.drizzle.db.transaction(async (tx) => {
      const debit = await this.wallet.debit(tx, {
        userId: actorId,
        amount: input.amount,
        type: 'gift',
      });
      if (!debit.ok) {
        throw new InsufficientBalanceError();
      }
      const credit = await this.wallet.credit(tx, {
        userId: targetUserId,
        amount: input.amount,
        type: 'gift',
      });
      if (!credit.ok) {
        throw new ChatPlayerNotFoundError(input.targetUsername);
      }
      const systemMsg = await this.systemWriter.postSystemMessage({
        roomId: input.roomId,
        actorId,
        tx,
        metadata: {
          command: 'gift',
          fromUserId: actorId,
          toUserId: targetUserId,
          amount: input.amount,
          currency: debit.currency,
        },
      });
      return { msg: systemMsg, currency: debit.currency };
    });
    await this.audit.record({
      actorId,
      actorType: 'player',
      action: 'chat.gift',
      resourceType: 'player',
      resourceId: targetUserId,
      before: null,
      after: { amount: input.amount },
    });
    void this.events.emit('chat.gift.sent', {
      fromUserId: actorId,
      toUserId: targetUserId,
      amount: input.amount,
      currency,
      messageId: msg.id,
    });
    return msg;
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
    void this.events.emit('chat.rain.distributed', {
      fromUserId: actorId,
      recipientCount: recipients.length,
      totalAmount: input.amount,
      currency,
      roomId: input.roomId,
    });
    return msg;
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

import { eq, asc, desc, count } from 'drizzle-orm';
import {
  DrizzleService,
  findOneOrThrow,
  pageToOffset,
  makeNotFoundError,
} from '@openora/core/server';
import type {
  Uuid,
  ChatBlockWriter,
  AdminUserDirectory,
  RealtimeTransport,
  AuditWritePort,
} from '@openora/core/contracts';
import { chatChannel } from '@openora/core/contracts';
import type { SortOrder } from '@openora/core/contracts/kit';
import type {
  ChatCommandDescriptor,
  ChatCommandType,
  CommandConfig,
  AdminCommandSortBy,
} from '../contract/index.js';
import { ChatCommandTypeSchema } from '../contract/index.js';
import { chatCommandConfig } from '../schema/index.js';
export const CommandDisabledError = makeNotFoundError('ChatCommand');

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

  async searchMentions({
    q,
    limit,
    roomId,
    viewerId,
  }: {
    q: string;
    limit: number;
    roomId: Uuid | null;
    viewerId: Uuid;
  }) {
    const onlineUserIds = await this.transport.getOnlineUserIds(chatChannel(roomId));
    if (onlineUserIds.length === 0) {
      return [];
    }

    const onlineIds = new Set(onlineUserIds);
    const query = q.trim();
    const canSeeAdminUsers = await this.canSeeAdminUsers(viewerId);
    let ids =
      query.length === 0
        ? onlineUserIds
        : await this.directory.findPlayerIds(query, Math.max(limit, onlineUserIds.length));
    if (canSeeAdminUsers && query.length > 0) {
      const onlineAccounts = await this.directory.lookupUsers(onlineUserIds);
      const queryLower = query.toLowerCase();
      const matchingAdminIds = onlineAccounts
        .filter(
          (account) =>
            (account.role === 'admin' || account.role === 'super-admin') &&
            [account.name, account.email].some((value) =>
              value?.toLowerCase().includes(queryLower),
            ),
        )
        .map((account) => account.id);
      ids = [...new Set([...ids, ...matchingAdminIds])];
    }
    if (ids.length === 0) {
      return [];
    }
    const excluded = new Set(await this.blockWriter.getExcludedUserIds(viewerId));
    const filteredIds = ids
      .filter((id) => id !== viewerId && onlineIds.has(id) && !excluded.has(id))
      .slice(0, limit);
    if (filteredIds.length === 0) {
      return [];
    }
    const summaries = await this.directory.lookupPlayers(filteredIds);
    if (!canSeeAdminUsers) {
      return summaries.map((s) => ({ userId: s.userId, username: s.username }));
    }

    const summaryById = new Map(summaries.map((summary) => [summary.userId, summary.username]));
    const accounts = canSeeAdminUsers ? await this.directory.lookupUsers(filteredIds) : [];
    const accountsById = new Map(accounts.map((account) => [account.id, account]));
    const visible = filteredIds.map((userId) => {
      const username = summaryById.get(userId);
      if (username) {
        return { userId, username };
      }
      const account = accountsById.get(userId);
      return account ? { userId, username: account.name ?? account.email } : null;
    });
    return visible.filter((user): user is { userId: Uuid; username: string } => user !== null);
  }

  private async canSeeAdminUsers(viewerId: Uuid) {
    if (typeof this.directory.get !== 'function') {
      return false;
    }
    const viewer = await this.directory.get(viewerId);
    return viewer?.role === 'admin' || viewer?.role === 'super-admin';
  }
}

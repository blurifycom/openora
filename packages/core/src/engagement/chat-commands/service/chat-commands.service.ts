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
import { ChatCommandTypeSchema, CommandConfigSchema } from '../contract/index.js';
import { chatCommandConfig } from '../schema/index.js';
export const CommandDisabledError = makeNotFoundError('ChatCommand');

// `key` is text and `config` is jsonb, so the column types are casts Postgres never enforced:
// a row written by an older release can hold a key this build no longer knows or a config shape
// it no longer accepts. Both are parsed here so one stale row loses its limit, or drops out of
// the list, instead of failing output validation and taking the whole command list down.
function toDescriptor(row: typeof chatCommandConfig.$inferSelect): ChatCommandDescriptor | null {
  const key = ChatCommandTypeSchema.safeParse(row.key);
  if (!key.success) {
    return null;
  }
  const config = CommandConfigSchema.safeParse(row.config);
  return {
    key: key.data,
    enabled: row.enabled,
    label: row.label,
    description: row.description ?? null,
    config: config.success ? config.data : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toDescriptors(rows: (typeof chatCommandConfig.$inferSelect)[]): ChatCommandDescriptor[] {
  return rows.map(toDescriptor).filter((d) => d !== null);
}

const ADMIN_COMMAND_SORT_COLUMNS = {
  key: chatCommandConfig.key,
  updatedAt: chatCommandConfig.updatedAt,
} as const satisfies Record<AdminCommandSortBy, unknown>;

const isStaffRole = (role: string | undefined) => role === 'admin' || role === 'super-admin';

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
    return toDescriptors(rows);
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
    return { items: toDescriptors(rows), total: Number(n), page, limit };
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
    // The write just set `key` and `config` from contract-validated input, so this row cannot
    // be the stale shape `toDescriptor` returns null for.
    return findOneOrThrow(toDescriptors([row]), new CommandDisabledError(input.key));
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
    const query = q.trim();
    const onlineUserIds = await this.transport.getOnlineUserIds(chatChannel(roomId));
    if (query.length === 0 && onlineUserIds.length === 0) {
      return [];
    }

    const onlineIds = new Set(onlineUserIds);
    const excluded = new Set(await this.blockWriter.getExcludedUserIds(viewerId));
    excluded.add(viewerId);
    const canSeeAdminUsers = await this.canSeeAdminUsers(viewerId);
    let ids =
      query.length === 0
        ? onlineUserIds
        : await this.directory.findPlayerIds(query, limit, {
            excludeUserIds: [...excluded],
            playerOnly: true,
          });
    if (canSeeAdminUsers && query.length > 0) {
      const onlineAccounts = await this.directory.lookupUsers(onlineUserIds);
      const queryLower = query.toLowerCase();
      const matchingAdminIds = onlineAccounts
        .filter(
          (account) =>
            isStaffRole(account.role) &&
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
    const candidateIds = ids.filter(
      (id) => !excluded.has(id) && (query.length > 0 || onlineIds.has(id)),
    );
    if (candidateIds.length === 0) {
      return [];
    }
    const summaries = await this.directory.lookupPlayers(candidateIds);
    if (!canSeeAdminUsers) {
      return summaries.slice(0, limit).map((s) => ({ userId: s.userId, username: s.username }));
    }

    const summaryById = new Map(summaries.map((summary) => [summary.userId, summary.username]));
    const accounts = await this.directory.lookupUsers(candidateIds);
    const accountsById = new Map(accounts.map((account) => [account.id, account]));
    const visible = candidateIds.flatMap((userId) => {
      const username = summaryById.get(userId);
      if (username) {
        return [{ userId, username }];
      }
      const account = accountsById.get(userId);
      if (!account || !onlineIds.has(userId)) {
        return [];
      }
      return [{ userId, username: account.name ?? account.email }];
    });
    return visible.slice(0, limit);
  }

  private async canSeeAdminUsers(viewerId: Uuid) {
    if (typeof this.directory.get !== 'function') {
      return false;
    }
    const viewer = await this.directory.get(viewerId);
    return isStaffRole(viewer?.role);
  }
}

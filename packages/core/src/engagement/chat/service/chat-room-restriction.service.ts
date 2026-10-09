import { and, count, desc, eq, gt, inArray, isNull, or, sql, SQL, type Column } from 'drizzle-orm';
import { unionAll } from 'drizzle-orm/pg-core';
import { DrizzleService, pageToOffset } from '@openora/core/server';
import {
  GLOBAL_CHAT_ROOM_ID,
  type AdminUserDirectory,
  type ChatModerationScope,
  type Uuid,
} from '@openora/core/contracts';
import {
  chatMute,
  chatPlatformBan,
  chatPlayerCooldown,
  chatRoom,
  chatRoomBan,
  chatRoomMute,
} from '../schema/index.js';
import type {
  ChatRoomRestriction,
  ChatRoomRestrictionSource,
  ChatRoomRestrictionType,
  ListRoomRestrictionsInput,
} from '../contract/index.js';
import { platformScopesFor, roomReach } from '../moderation/index.js';
import { ChatRoomNotFoundError } from './errors/chat-moderation.errors.js';

type RestrictionTable =
  | typeof chatMute
  | typeof chatPlatformBan
  | typeof chatPlayerCooldown
  | typeof chatRoomMute
  | typeof chatRoomBan;

type RoomRef = Pick<typeof chatRoom.$inferSelect, 'id' | 'slug' | 'isPublic'>;

// UNION ALL pairs columns by position, so every branch selects these keys in this order.
function restrictionFields<T extends RestrictionTable>(
  type: ChatRoomRestrictionType,
  source: ChatRoomRestrictionSource,
  table: T,
  columns: {
    scope: Column | SQL;
    roomId: Column;
    reason: Column | SQL;
    setById: Column;
    cooldownSeconds?: Column;
  },
) {
  return {
    id: table.id,
    type: new SQL.Aliased<ChatRoomRestrictionType>(sql`${type}::text`, 'type'),
    source: new SQL.Aliased<ChatRoomRestrictionSource>(sql`${source}::text`, 'source'),
    userId: table.userId,
    scope: new SQL.Aliased<ChatModerationScope>(sql`${columns.scope}::text`, 'scope'),
    roomId: new SQL.Aliased<Uuid | null>(sql`${columns.roomId}`, 'room_id'),
    reason: new SQL.Aliased<string | null>(sql`${columns.reason}`, 'reason'),
    setById: new SQL.Aliased<Uuid>(sql`${columns.setById}`, 'set_by_id'),
    createdAt: table.createdAt,
    expiresAt: table.expiresAt,
    cooldownSeconds: new SQL.Aliased<number | null>(
      sql`${columns.cooldownSeconds ?? sql`null`}::integer`,
      'cooldown_seconds',
    ),
  };
}

const isActive = (table: RestrictionTable, now: Date) =>
  and(isNull(table.liftedAt), or(isNull(table.expiresAt), gt(table.expiresAt, now)));

function restrictionsReaching(
  db: DrizzleService['db'],
  room: RoomRef,
  type: ChatRoomRestrictionType | undefined,
  now: Date,
) {
  const platformScopes = platformScopesFor(roomReach(room));
  const reachesRoom = (
    table: typeof chatMute | typeof chatPlatformBan | typeof chatPlayerCooldown,
  ) =>
    or(
      inArray(table.scope, platformScopes),
      and(eq(table.scope, 'room'), eq(table.roomId, room.id)),
    );
  const ofType = (branchType: ChatRoomRestrictionType) =>
    type === undefined || type === branchType ? undefined : sql`false`;
  const roomScope = sql`'room'`;
  return unionAll(
    db
      .select(
        restrictionFields('mute', 'admin', chatMute, {
          scope: chatMute.scope,
          roomId: chatMute.roomId,
          reason: chatMute.reason,
          setById: chatMute.mutedBy,
        }),
      )
      .from(chatMute)
      .where(and(ofType('mute'), isActive(chatMute, now), reachesRoom(chatMute))),
    db
      .select(
        restrictionFields('mute', 'room', chatRoomMute, {
          scope: roomScope,
          roomId: chatRoomMute.roomId,
          reason: chatRoomMute.reason,
          setById: chatRoomMute.mutedBy,
        }),
      )
      .from(chatRoomMute)
      .where(and(ofType('mute'), isActive(chatRoomMute, now), eq(chatRoomMute.roomId, room.id))),
    db
      .select(
        restrictionFields('ban', 'admin', chatPlatformBan, {
          scope: chatPlatformBan.scope,
          roomId: chatPlatformBan.roomId,
          reason: chatPlatformBan.reason,
          setById: chatPlatformBan.bannedBy,
        }),
      )
      .from(chatPlatformBan)
      .where(and(ofType('ban'), isActive(chatPlatformBan, now), reachesRoom(chatPlatformBan))),
    db
      .select(
        restrictionFields('ban', 'room', chatRoomBan, {
          scope: roomScope,
          roomId: chatRoomBan.roomId,
          reason: sql`null::text`,
          setById: chatRoomBan.bannedBy,
        }),
      )
      .from(chatRoomBan)
      .where(and(ofType('ban'), isActive(chatRoomBan, now), eq(chatRoomBan.roomId, room.id))),
    db
      .select(
        restrictionFields('cooldown', 'admin', chatPlayerCooldown, {
          scope: chatPlayerCooldown.scope,
          roomId: chatPlayerCooldown.roomId,
          reason: chatPlayerCooldown.reason,
          setById: chatPlayerCooldown.createdBy,
          cooldownSeconds: chatPlayerCooldown.cooldownSeconds,
        }),
      )
      .from(chatPlayerCooldown)
      .where(
        and(ofType('cooldown'), isActive(chatPlayerCooldown, now), reachesRoom(chatPlayerCooldown)),
      ),
  );
}

type RestrictionRow = Awaited<ReturnType<typeof restrictionsReaching>>[number];

export class ChatRoomRestrictionService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly directory: AdminUserDirectory,
  ) {}

  async listRoomRestrictions({ roomId, type, page, limit }: ListRoomRestrictionsInput) {
    const [room] = await this.drizzle.db
      .select({ id: chatRoom.id, slug: chatRoom.slug, isPublic: chatRoom.isPublic })
      .from(chatRoom)
      .where(
        and(
          roomId === GLOBAL_CHAT_ROOM_ID
            ? eq(chatRoom.slug, GLOBAL_CHAT_ROOM_ID)
            : eq(chatRoom.id, roomId),
          isNull(chatRoom.deletedAt),
        ),
      )
      .limit(1);
    if (!room) {
      throw new ChatRoomNotFoundError(roomId);
    }
    const restrictions = restrictionsReaching(this.drizzle.db, room, type, new Date()).as(
      'restrictions',
    );
    const [rows, [{ total }]] = await Promise.all([
      this.drizzle.db
        .select()
        .from(restrictions)
        .orderBy(desc(restrictions.createdAt), desc(restrictions.id))
        .limit(limit)
        .offset(pageToOffset(page, limit)),
      this.drizzle.db.select({ total: count() }).from(restrictions),
    ]);
    return { items: await this.withNames(rows), total, page, limit };
  }

  // A room moderator is a player and shows by username; staff show by account name.
  private async withNames(rows: RestrictionRow[]): Promise<ChatRoomRestriction[]> {
    const playerIds = rows.flatMap((row) =>
      row.source === 'room' ? [row.userId, row.setById] : [row.userId],
    );
    const staffIds = rows.filter((row) => row.source === 'admin').map((row) => row.setById);
    const [players, staff] = await Promise.all([
      this.directory.lookupPlayers([...new Set(playerIds)]),
      this.directory.lookupUsers([...new Set(staffIds)]),
    ]);
    const usernames = new Map(players.map((summary) => [summary.userId, summary.username]));
    const staffNames = new Map(staff.map((account) => [account.id, account.name]));
    return rows.map(({ setById, createdAt, expiresAt, ...row }) => ({
      ...row,
      username: usernames.get(row.userId) ?? null,
      setByName: (row.source === 'room' ? usernames.get(setById) : staffNames.get(setById)) ?? null,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt?.toISOString() ?? null,
    }));
  }
}

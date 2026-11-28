import type {
  AdminUserDirectory,
  AdminUserListOptions,
  ClientMeta,
  KycStatus,
  MailRecipientDirectory,
  McpTokenAutomaticRevokeReason,
  McpTokenRevocation,
  PlayerIdSearchOptions,
} from '@openora/core/contracts';
import { KycStatusSchema, normalizeKycStatus, UuidSchema } from '@openora/core/contracts';
import { DrizzleService, pageToOffset } from '@openora/core/server';
import type { EventBus } from '@openora/core/server';
import {
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  ne,
  notInArray,
  or,
  sql,
  and,
} from 'drizzle-orm';
import { user } from './schema/index.js';
import type { PlayEligibilityPublisher } from './service/play-eligibility.service.js';
import { expireActiveSessions } from './service/session.service.js';
import { player } from '@openora/core/pam/schema/profile';

export const escapeLikePattern = (value: string) => value.replaceAll(/[%_\\]/g, '\\$&');

const PLAYER_LOOKUP_COLUMNS = {
  playerId: player.id,
  userId: player.userId,
  username: user.username,
  kycStatus: player.kycStatus,
  email: user.email,
  language: user.language,
  avatarUrl: user.image,
  createdAt: player.createdAt,
  level: player.level,
  currency: player.currency,
};

function withKycStatus<T extends { kycStatus: string | null }>(row: T) {
  const kyc = KycStatusSchema.safeParse(row.kycStatus);
  return { ...row, kycStatus: kyc.success ? normalizeKycStatus(kyc.data) : null };
}

function toRow(r: typeof user.$inferSelect) {
  return {
    id: r.id,
    email: r.email,
    name: r.name ?? null,
    createdAt: r.createdAt,
    isActive: r.isActive,
    role: r.role,
    language: r.language ?? null,
    failedLoginAttempts: r.failedLoginAttempts,
    lockoutUntil: r.lockoutUntil,
  };
}

type AdminUserPatch = { isActive?: boolean; role?: string };

export function automaticMcpRevokeReason(
  patch: AdminUserPatch,
): McpTokenAutomaticRevokeReason | null {
  if (patch.isActive === false) {
    return 'admin_disabled';
  }
  if (patch.role !== undefined && patch.role !== 'admin') {
    return 'admin_role_removed';
  }
  return null;
}

export class DrizzleAdminUserDirectory implements AdminUserDirectory {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
    private readonly playEligibility: PlayEligibilityPublisher,
    private readonly mcpTokens?: McpTokenRevocation,
  ) {}

  async count() {
    const [r] = await this.drizzle.db.select({ n: count() }).from(user);
    return Number(r?.n ?? 0);
  }

  async list({ page, limit, search, staffOnly, sortBy, sortOrder }: AdminUserListOptions) {
    const db = this.drizzle.db;
    const where = and(
      search ? ilike(user.email, `%${search}%`) : undefined,
      staffOnly ? ne(user.role, 'player') : undefined,
    );
    const dir = (sortOrder ?? 'desc') === 'asc' ? asc : desc;
    const USER_SORT_COLS = {
      createdAt: user.createdAt,
      email: user.email,
      name: user.name,
      role: user.role,
      isActive: user.isActive,
      lastLockoutAt: user.lastLockoutAt,
    } as const;
    const col =
      USER_SORT_COLS[
        sortBy === 'email' ||
        sortBy === 'name' ||
        sortBy === 'role' ||
        sortBy === 'isActive' ||
        sortBy === 'lastLockoutAt'
          ? sortBy
          : 'createdAt'
      ];
    const [rows, [{ n }]] = await Promise.all([
      db
        .select()
        .from(user)
        .where(where)
        .orderBy(dir(col), desc(user.id))
        .limit(limit)
        .offset(pageToOffset(page, limit)),
      db.select({ n: count() }).from(user).where(where),
    ]);
    return { rows: rows.map(toRow), total: Number(n) };
  }

  async get(id: string) {
    const [r] = await this.drizzle.db.select().from(user).where(eq(user.id, id));
    return r ? toRow(r) : null;
  }

  async lookupUsers(userIds: readonly string[]) {
    if (userIds.length === 0) {
      return [];
    }
    const rows = await this.drizzle.db
      .select()
      .from(user)
      .where(inArray(user.id, [...userIds]));
    return rows.map(toRow);
  }

  async update(
    id: string,
    patch: AdminUserPatch,
    actorId: string,
    meta?: ClientMeta,
    options: Parameters<AdminUserDirectory['update']>[4] = {},
  ) {
    const set: Partial<typeof user.$inferInsert> = {};
    if (patch.isActive !== undefined) {
      set.isActive = patch.isActive;
    }
    if (patch.role !== undefined) {
      set.role = patch.role;
    }
    const ip = meta?.ip ?? null;
    const userAgent = meta?.userAgent ?? null;
    const mcpRevokeReason = automaticMcpRevokeReason(patch);

    const written = await this.drizzle.db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ isActive: user.isActive, role: user.role })
        .from(user)
        .where(eq(user.id, id))
        .for('update');
      if (!existing) {
        return null;
      }
      await options.beforeWrite?.(tx, existing);
      const [updated] = await tx.update(user).set(set).where(eq(user.id, id)).returning();
      if (!updated) {
        return null;
      }
      const sessionsEnded = patch.isActive === false ? await expireActiveSessions(tx, id) : 0;
      if (patch.isActive !== undefined && patch.isActive !== existing.isActive) {
        await this.playEligibility.publish(tx, id);
      }
      if (mcpRevokeReason) {
        await this.mcpTokens?.revokeAllForUser(
          { userId: id, reason: mcpRevokeReason, actorId, ip, userAgent },
          tx,
        );
      }
      const [account] =
        sessionsEnded > 0
          ? await tx.select({ playerId: player.id }).from(player).where(eq(player.userId, id))
          : [];
      return {
        wasActive: existing.isActive,
        updated,
        sessionsEnded,
        playerId: account?.playerId ?? null,
      };
    });
    if (!written) {
      return null;
    }

    if (patch.isActive !== undefined && patch.isActive !== written.wasActive) {
      if (patch.isActive) {
        this.events.emit('identity.user.reactivated', { userId: id, actorId, ip, userAgent });
      } else {
        this.events.emit('identity.user.deactivated', { userId: id, actorId, ip, userAgent });
      }
    }
    if (written.sessionsEnded > 0) {
      this.events.emit('identity.sessions.revoked_all', {
        userId: id,
        playerId: written.playerId,
        actorId,
        ip,
        userAgent,
      });
    }
    return toRow(written.updated);
  }

  async lookupPlayers(userIds: readonly string[]) {
    if (userIds.length === 0) {
      return [];
    }
    const rows = await this.drizzle.db
      .select(PLAYER_LOOKUP_COLUMNS)
      .from(player)
      .innerJoin(user, eq(player.userId, user.id))
      .where(and(inArray(player.userId, [...userIds]), eq(user.role, 'player')));
    return rows.map(withKycStatus);
  }

  async getPlayerByUsername(username: string) {
    const rows = await this.drizzle.db
      .select(PLAYER_LOOKUP_COLUMNS)
      .from(player)
      .innerJoin(user, eq(player.userId, user.id))
      .where(eq(sql`lower(${user.username})`, username.toLowerCase()))
      .limit(1);
    const [row] = rows;
    if (!row) {
      return null;
    }
    return withKycStatus(row);
  }

  async findPlayerIds(query: string, limit = 1000, options?: PlayerIdSearchOptions) {
    const term = `%${escapeLikePattern(query)}%`;
    const conditions = [ilike(user.email, term), ilike(user.username, term)];
    if (UuidSchema.safeParse(query).success) {
      conditions.push(eq(player.id, query), eq(player.userId, query));
    }
    const rows = await this.drizzle.db
      .selectDistinct({ id: user.id })
      .from(user)
      .leftJoin(player, eq(player.userId, user.id))
      .where(
        and(
          or(...conditions),
          options?.playerOnly ? and(eq(user.role, 'player'), isNotNull(player.id)) : undefined,
          options?.excludeUserIds?.length
            ? notInArray(user.id, [...options.excludeUserIds])
            : undefined,
        ),
      )
      .limit(limit);
    return rows.map((r) => r.id);
  }

  async findUserIdsByKycStatus(status: KycStatus, limit = 1000) {
    const matches: KycStatus[] =
      normalizeKycStatus(status) === 'approved' ? ['approved', 'verified'] : [status];
    const rows = await this.drizzle.db
      .select({ userId: player.userId })
      .from(player)
      .where(inArray(player.kycStatus, matches))
      .limit(limit);
    return rows.map((r) => r.userId);
  }
}

export class DrizzleMailRecipientDirectory implements MailRecipientDirectory {
  constructor(private readonly drizzle: DrizzleService) {}

  async getMailRecipient(userId: string) {
    const [recipient] = await this.drizzle.db
      .select({
        email: user.email,
        language: user.language,
        name: user.username,
        antiPhishingCode: user.antiPhishingCode,
      })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    return recipient ?? null;
  }
}

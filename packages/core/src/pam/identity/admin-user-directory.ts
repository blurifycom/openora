import type { AdminUserDirectory, AdminUserListOptions, ClientMeta } from '@openora/core/contracts';
import { KycStatusSchema, normalizeKycStatus } from '@openora/core/contracts';
import { DrizzleService, pageToOffset } from '@openora/core/server';
import type { EventBus } from '@openora/core/server';
import { asc, count, desc, eq, ilike, inArray } from 'drizzle-orm';
import { user } from './schema/index.js';
// Read-only cross-domain read of the player/profile table via the public /schema
// subpath (allowed per ADR-0020) so back-office lists can label players by
// username + KYC without leaking the schema to the consumer module.
import { player } from '@openora/core/pam/schema/profile';

// Identity owns the `user` table, so it owns the admin directory port.
// admin-console depends only on ADMIN_USER_DIRECTORY - never on this schema. See ADR-0017/0025.
function toRow(r: typeof user.$inferSelect) {
  return {
    id: r.id,
    email: r.email,
    name: r.name ?? null,
    createdAt: r.createdAt,
    isActive: r.isActive,
    role: r.role,
    failedLoginAttempts: r.failedLoginAttempts,
    lockoutUntil: r.lockoutUntil,
  };
}

export class DrizzleAdminUserDirectory implements AdminUserDirectory {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
  ) {}

  async count() {
    const [r] = await this.drizzle.db.select({ n: count() }).from(user);
    return Number(r?.n ?? 0);
  }

  async list({ page, limit, search, sortBy, sortOrder }: AdminUserListOptions) {
    const db = this.drizzle.db;
    const where = search ? ilike(user.email, `%${search}%`) : undefined;
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

  async update(
    id: string,
    patch: { isActive?: boolean; role?: string },
    actorId: string,
    meta?: ClientMeta,
  ) {
    const [existing] = await this.drizzle.db.select().from(user).where(eq(user.id, id));
    if (!existing) {
      return null;
    }
    const set: Partial<typeof user.$inferInsert> = {};
    if (patch.isActive !== undefined) {
      set.isActive = patch.isActive;
    }
    if (patch.role !== undefined) {
      set.role = patch.role;
    }
    const [r] = await this.drizzle.db.update(user).set(set).where(eq(user.id, id)).returning();
    if (!r) {
      return null;
    }

    // Emit only on an actual active-status flip, after the commit. Literal topics
    // (not a ternary) so the catalog generator's emit-scanner picks them up.
    if (patch.isActive !== undefined && patch.isActive !== existing.isActive) {
      const ip = meta?.ip ?? null;
      const userAgent = meta?.userAgent ?? null;
      if (patch.isActive) {
        this.events.emit('identity.user.reactivated', { userId: id, actorId, ip, userAgent });
      } else {
        this.events.emit('identity.user.deactivated', { userId: id, actorId, ip, userAgent });
      }
    }
    return toRow(r);
  }

  async lookupPlayers(userIds: readonly string[]) {
    if (userIds.length === 0) {
      return [];
    }
    const rows = await this.drizzle.db
      .select({
        userId: player.userId,
        username: player.displayName,
        kycStatus: player.kycStatus,
        email: user.email,
        language: user.language,
        avatarUrl: user.image,
        createdAt: player.createdAt,
        level: player.level,
        currency: player.currency,
      })
      .from(player)
      .innerJoin(user, eq(player.userId, user.id))
      .where(inArray(player.userId, [...userIds]));
    return rows.map((r) => {
      // The player table stores kycStatus as free text; coerce unknown values to null
      // so the port's KycStatus contract holds without a cast. Normalize the deprecated
      // `verified` value to `approved` here - the single read boundary every admin
      // consumer (wallet queue filter, tag evaluation, admin-console) goes through -
      // so a legacy row is indistinguishable from a fresh one downstream.
      const kyc = KycStatusSchema.safeParse(r.kycStatus);
      return {
        ...r,
        kycStatus: kyc.success ? normalizeKycStatus(kyc.data) : null,
      };
    });
  }

  async getPlayerByUsername(username: string) {
    const rows = await this.drizzle.db
      .select({
        userId: player.userId,
        username: player.displayName,
        kycStatus: player.kycStatus,
        email: user.email,
        language: user.language,
        avatarUrl: user.image,
        createdAt: player.createdAt,
        level: player.level,
        currency: player.currency,
      })
      .from(player)
      .innerJoin(user, eq(player.userId, user.id))
      .where(ilike(player.displayName, username))
      .limit(1);
    const [row] = rows;
    if (!row) {
      return null;
    }
    const kyc = KycStatusSchema.safeParse(row.kycStatus);
    return { ...row, kycStatus: kyc.success ? normalizeKycStatus(kyc.data) : null };
  }

  // Substring search is index-backed by the pg_trgm GIN indexes on user.email and
  // player.display_name; the 1000 cap is a safety bound on the id set, not a perf
  // crutch - it is effectively unreachable for a real admin search term.
  async findPlayerIds(query: string, limit = 1000) {
    const term = `%${query}%`;
    const [byEmail, byName] = await Promise.all([
      this.drizzle.db
        .select({ id: user.id })
        .from(user)
        .where(ilike(user.email, term))
        .limit(limit),
      this.drizzle.db
        .select({ userId: player.userId })
        .from(player)
        .where(ilike(player.displayName, term))
        .limit(limit),
    ]);
    const ids = new Set<string>();
    for (const r of byEmail) {
      ids.add(r.id);
    }
    for (const r of byName) {
      ids.add(r.userId);
    }
    return [...ids].slice(0, limit);
  }
}

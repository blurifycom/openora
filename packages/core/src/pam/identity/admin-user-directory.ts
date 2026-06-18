import type { AdminUserDirectory, AdminUserListOptions, AdminUserRow } from '@oss/core/contracts';
import { DrizzleService, pageToOffset } from '@oss/core/server';
import { count, desc, eq, ilike } from 'drizzle-orm';
import { user } from './schema/index.js';

// Identity owns the `user` table, so it owns the admin directory port.
// admin-console depends only on ADMIN_USER_DIRECTORY - never on this schema. See ADR-0017/0025.
function toRow(r: typeof user.$inferSelect): AdminUserRow {
  return {
    id: r.id,
    email: r.email,
    name: r.name ?? null,
    createdAt: r.createdAt,
    isActive: r.isActive,
    role: r.role ?? 'user',
  };
}

export class DrizzleAdminUserDirectory implements AdminUserDirectory {
  constructor(private readonly drizzle: DrizzleService) {}

  async count(): Promise<number> {
    const [r] = await this.drizzle.db.select({ n: count() }).from(user);
    return Number(r?.n ?? 0);
  }

  async list({ page, limit, search }: AdminUserListOptions) {
    const db = this.drizzle.db;
    const where = search ? ilike(user.email, `%${search}%`) : undefined;
    const [rows, [{ n }]] = await Promise.all([
      db
        .select()
        .from(user)
        .where(where)
        .orderBy(desc(user.createdAt))
        .limit(limit)
        .offset(pageToOffset(page, limit)),
      db.select({ n: count() }).from(user).where(where),
    ]);
    return { rows: rows.map(toRow), total: Number(n) };
  }

  async get(id: string): Promise<AdminUserRow | null> {
    const [r] = await this.drizzle.db.select().from(user).where(eq(user.id, id));
    return r ? toRow(r) : null;
  }

  async update(
    id: string,
    patch: { isActive?: boolean; role?: string },
  ): Promise<AdminUserRow | null> {
    const [existing] = await this.drizzle.db.select().from(user).where(eq(user.id, id));
    if (!existing) return null;
    const set: Partial<typeof user.$inferInsert> = {};
    if (patch.isActive !== undefined) set.isActive = patch.isActive;
    if (patch.role !== undefined) set.role = patch.role;
    const [r] = await this.drizzle.db.update(user).set(set).where(eq(user.id, id)).returning();
    return r ? toRow(r) : null;
  }
}

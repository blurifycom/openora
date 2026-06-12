import { getCurrentTenantId } from '@oss/core';
import { DrizzleService } from '@oss/db';
import { eq } from 'drizzle-orm';
import { player } from '../schema/index.js';
import { user } from '@oss/modules/platform/identity/schema';
import type {
  Player,
  PlayerStatus,
  KycStatus,
  UpdatePlayerProfileInput,
} from '../schemas/index.js';

function toPlayer(p: typeof player.$inferSelect, email: string): Player {
  return {
    id: p.id,
    userId: p.userId,
    displayName: p.displayName,
    email,
    country: p.country,
    currency: p.currency,
    language: p.language,
    status: p.status as PlayerStatus,
    kycStatus: p.kycStatus as KycStatus,
    level: p.level,
    totalWagered: Number(p.totalWagered),
    totalDeposits: Number(p.totalDeposits),
    lastSeenAt: p.lastSeenAt ? p.lastSeenAt.toISOString() : null,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

// Player-facing self-profile service. Owns the `player` table. The admin PAM
// surface lives in the premium @oss-premium/player-management package.
export class ProfileService {
  constructor(private readonly drizzle: DrizzleService) {}

  private async emailFor(userId: string): Promise<string> {
    const [record] = await this.drizzle.db
      .select({ email: user.email })
      .from(user)
      .where(eq(user.id, userId));
    return record?.email ?? '';
  }

  // Return the caller's player row, creating a default one on first access.
  // Registration only creates the auth `user`; the `player` profile row is
  // materialised lazily here so a freshly-registered user always has a profile.
  private async ensureProfile(userId: string): Promise<Player> {
    const [existing] = await this.drizzle.db.select().from(player).where(eq(player.userId, userId));
    if (existing) return toPlayer(existing, await this.emailFor(userId));

    const [u] = await this.drizzle.db
      .select({ name: user.name, email: user.email })
      .from(user)
      .where(eq(user.id, userId));
    const [created] = await this.drizzle.db
      .insert(player)
      .values({
        userId,
        displayName: u?.name ?? 'Player',
        tenantId: getCurrentTenantId() ?? 'default',
      })
      .returning();
    return toPlayer(created!, u?.email ?? '');
  }

  async getMyProfile(userId: string): Promise<Player> {
    return this.ensureProfile(userId);
  }

  async updateMyProfile(userId: string, data: UpdatePlayerProfileInput): Promise<Player> {
    await this.ensureProfile(userId);
    const patch: Partial<typeof player.$inferInsert> = {};
    if (data.displayName !== undefined) patch.displayName = data.displayName;
    if (data.country !== undefined) patch.country = data.country;
    if (data.currency !== undefined) patch.currency = data.currency;
    if (data.language !== undefined) patch.language = data.language;
    const [record] = await this.drizzle.db
      .update(player)
      .set(patch)
      .where(eq(player.userId, userId))
      .returning();
    return toPlayer(record!, await this.emailFor(userId));
  }
}

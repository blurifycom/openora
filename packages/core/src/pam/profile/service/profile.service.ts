import { DrizzleService } from '@blurifycom/core/server';
import { eq } from 'drizzle-orm';
import { player } from '../schema/index.js';
import { user } from '../../identity/schema/index.js';
import type { UpdatePlayerProfileInput } from '../schemas/index.js';
import { toPlayer, fetchEmail } from '../../shared/player-mapper.js';

export class ProfileService {
  constructor(private readonly drizzle: DrizzleService) {}

  // Registration only creates the auth `user`; the `player` row is materialised
  // lazily so a freshly-registered user always has a profile.
  private async ensureProfile(userId: string) {
    const [existing] = await this.drizzle.db.select().from(player).where(eq(player.userId, userId));
    if (existing) return toPlayer(existing, await fetchEmail(this.drizzle, userId));

    const [u] = await this.drizzle.db
      .select({ name: user.name, email: user.email })
      .from(user)
      .where(eq(user.id, userId));
    const [created] = await this.drizzle.db
      .insert(player)
      .values({
        userId,
        displayName: u?.name ?? 'Player',
      })
      .returning();
    return toPlayer(created!, u?.email ?? '');
  }

  async getMyProfile(userId: string) {
    return this.ensureProfile(userId);
  }

  async updateMyProfile(userId: string, data: UpdatePlayerProfileInput) {
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
    return toPlayer(record!, await fetchEmail(this.drizzle, userId));
  }
}

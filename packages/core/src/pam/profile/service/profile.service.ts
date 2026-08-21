import { DrizzleService } from '@openora/core/server';
import type { PlayerProvisioning, PlayerRegistrationRecord, User } from '@openora/core/contracts';
import { eq } from 'drizzle-orm';
import { player } from '../schema/index.js';
import { user } from '@openora/core/pam/schema/identity';
import type { UpdatePlayerProfileInput } from '../contract/index.js';
import { toPlayer, fetchEmailByUserId, fetchUsernameByUserId } from '../../shared/player-mapper.js';

export class ProfileService implements PlayerProvisioning {
  constructor(private readonly drizzle: DrizzleService) {}

  /** Idempotent: a retried registration never overwrites the original consent record. */
  async createForRegistration({ userId, ...consent }: PlayerRegistrationRecord) {
    const [u] = await this.drizzle.db
      .select({ name: user.name, username: user.username })
      .from(user)
      .where(eq(user.id, userId));
    const inserted = await this.drizzle.db
      .insert(player)
      .values({ userId, displayName: u?.username ?? u?.name ?? 'Player', ...consent })
      .onConflictDoNothing({ target: player.userId })
      .returning({ id: player.id });
    return { created: inserted.length > 0 };
  }

  private async ensureProfile(userId: User['id']) {
    const [existing] = await this.drizzle.db.select().from(player).where(eq(player.userId, userId));
    if (existing) {
      return toPlayer(
        existing,
        await fetchEmailByUserId(this.drizzle, userId),
        await fetchUsernameByUserId(this.drizzle, userId),
      );
    }

    const [u] = await this.drizzle.db
      .select({ name: user.name, email: user.email, username: user.username })
      .from(user)
      .where(eq(user.id, userId));
    // Upsert: a concurrent first-hit may insert the row between our select and
    // this insert. The no-op set makes the conflict path return the winning row
    // without overwriting it, so we always get exactly one row back.
    const [created] = await this.drizzle.db
      .insert(player)
      .values({
        userId,
        displayName: u?.username ?? u?.name ?? 'Player',
      })
      .onConflictDoUpdate({ target: player.userId, set: { userId } })
      .returning();
    return toPlayer(created, u?.email ?? '', u?.username ?? null);
  }

  async getMyProfile(userId: User['id']) {
    return this.ensureProfile(userId);
  }

  async updateMyProfile(userId: User['id'], data: UpdatePlayerProfileInput) {
    await this.ensureProfile(userId);
    const [record] = await this.drizzle.db
      .update(player)
      .set(data)
      .where(eq(player.userId, userId))
      .returning();
    return toPlayer(
      record,
      await fetchEmailByUserId(this.drizzle, userId),
      await fetchUsernameByUserId(this.drizzle, userId),
    );
  }
}

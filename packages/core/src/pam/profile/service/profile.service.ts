import { DrizzleService, makeNotFoundError } from '@openora/core/server';
import type { PlayerProvisioning, PlayerRegistrationRecord, User } from '@openora/core/contracts';
import { eq } from 'drizzle-orm';
import { player } from '../schema/index.js';
import { user } from '@openora/core/pam/schema/identity';
import type { UpdatePlayerProfileInput } from '../contract/index.js';
import { toPlayer, fetchEmailByUserId, fetchUsernameByUserId } from '../../shared/player-mapper.js';

export const ProfileUserNotFoundError = makeNotFoundError('User');

export class ProfileService implements PlayerProvisioning {
  constructor(private readonly drizzle: DrizzleService) {}

  /** Idempotent: a retried registration never overwrites the original consent record. */
  async createForRegistration({ userId, ...consent }: PlayerRegistrationRecord) {
    const [inserted] = await this.drizzle.db
      .insert(player)
      .values({ userId, ...consent })
      .onConflictDoNothing({ target: player.userId })
      .returning({ id: player.id });
    return inserted ? { created: true, playerId: inserted.id } : { created: false };
  }

  /**
   * `player.user_id` carries no foreign key (cross-module FKs are not allowed), so the
   * identity row is resolved first: materialising a profile for a missing user would
   * create an orphan that every downstream join then has to defend against.
   */
  private async ensureProfile(userId: User['id']) {
    const [identity] = await this.drizzle.db
      .select({ email: user.email, username: user.username })
      .from(user)
      .where(eq(user.id, userId));
    if (!identity) {
      throw new ProfileUserNotFoundError(userId);
    }

    const [existing] = await this.drizzle.db.select().from(player).where(eq(player.userId, userId));
    if (existing) {
      return toPlayer(existing, identity.email, identity.username);
    }

    // Upsert: a concurrent first-hit may insert the row between our select and
    // this insert. The no-op set makes the conflict path return the winning row
    // without overwriting it, so we always get exactly one row back.
    const [created] = await this.drizzle.db
      .insert(player)
      .values({ userId })
      .onConflictDoUpdate({ target: player.userId, set: { userId } })
      .returning();
    return toPlayer(created, identity.email, identity.username);
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

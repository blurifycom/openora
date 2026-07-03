import { createDomainError, DrizzleService } from '@blurifycom/core/server';
import type { PlatformConfig } from '@blurifycom/core/contracts';
import { eq } from 'drizzle-orm';
import { player } from '../schema/index.js';
import { user } from '@blurifycom/core/pam/schema/identity';
import type { UpdatePlayerProfileInput } from '../contract/index.js';
import { toPlayer, fetchEmail } from '../../shared/player-mapper.js';

export const UnsopportedLanguageError = createDomainError(
  'UnsopportedLanguageError',
  (language: string) => `${language} is not supported`,
);

export class ProfileService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly platformConfig?: PlatformConfig,
  ) {}

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
    const supportedLanguages = this.platformConfig?.supportedLanguages;
    if (
      data.language !== undefined &&
      supportedLanguages &&
      supportedLanguages.length > 0 &&
      !supportedLanguages.includes(data.language)
    ) {
      throw new UnsopportedLanguageError(data.language);
    }
    await this.ensureProfile(userId);
    const patch: Partial<typeof player.$inferInsert> = {};
    if (data.displayName !== undefined) patch.displayName = data.displayName;
    if (data.country !== undefined) patch.country = data.country;
    if (data.currency !== undefined) patch.currency = data.currency;
    if (data.language !== undefined) patch.language = data.language;
    if (data.theme !== undefined) patch.theme = data.theme;
    const [record] = await this.drizzle.db
      .update(player)
      .set(patch)
      .where(eq(player.userId, userId))
      .returning();
    return toPlayer(record!, await fetchEmail(this.drizzle, userId));
  }
}

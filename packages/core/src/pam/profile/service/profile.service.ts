import { DrizzleService, createDomainError } from '@blurifycom/core/server';
import type { PlatformConfig } from '@blurifycom/core/contracts';
import { eq } from 'drizzle-orm';
import { player } from '../schema/index.js';
import { user } from '../../identity/schema/index.js';
import type { PlayerStatus, KycStatus, UpdatePlayerProfileInput } from '../schemas/index.js';

export const UnsupportedLanguageError = createDomainError<[lang: string]>(
  'UnsupportedLanguageError',
  (lang) => `Unsupported language: ${lang}`,
);

function toPlayer(p: typeof player.$inferSelect, email: string) {
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

export class ProfileService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly platformConfig?: PlatformConfig,
  ) {}

  private async emailFor(userId: string) {
    const [record] = await this.drizzle.db
      .select({ email: user.email })
      .from(user)
      .where(eq(user.id, userId));
    return record?.email ?? '';
  }

  // Registration only creates the auth `user`; the `player` row is materialised
  // lazily so a freshly-registered user always has a profile.
  private async ensureProfile(userId: string) {
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
      throw new UnsupportedLanguageError(data.language);
    }
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

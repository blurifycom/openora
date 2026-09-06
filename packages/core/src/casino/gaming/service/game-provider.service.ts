import {
  type EventBus,
  makeNotFoundError,
  makeConflictError,
  DrizzleService,
  findOneOrThrow,
  isUniqueConstraintViolation,
  likeContains,
  serializeRow,
  pageToOffset,
} from '@openora/core/server';
import { eq, and, asc, count, ilike, ne, or } from 'drizzle-orm';
import type { ClientMeta, User } from '@openora/core/contracts';
import { gameProvider } from '../schema/index.js';
import type { UpdateProviderInput } from '../contract/index.js';

export const GameProviderNotFoundError = makeNotFoundError('GameProvider');
export const GameProviderSlugTakenError = makeConflictError(
  'GameProviderSlugTakenError',
  'A provider with this slug already exists',
);

type Actor = {
  actorId?: User['id'];
} & ClientMeta;

export function toProviderSummary(record: typeof gameProvider.$inferSelect) {
  return {
    id: record.id,
    slug: record.slug,
    name: record.name,
    logoUrl: record.logoUrl,
  };
}

function toProviderDetail(record: typeof gameProvider.$inferSelect) {
  const dates = serializeRow(record, { dateFields: ['createdAt', 'updatedAt'] });
  return {
    ...toProviderSummary(record),
    aggregatorVendorId: record.aggregatorVendorId,
    isActive: record.isActive,
    createdAt: dates.createdAt,
    updatedAt: dates.updatedAt,
  };
}

export class GameProviderService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
  ) {}

  async listActiveProviders() {
    const rows = await this.drizzle.db
      .select({
        id: gameProvider.id,
        slug: gameProvider.slug,
        name: gameProvider.name,
        logoUrl: gameProvider.logoUrl,
      })
      .from(gameProvider)
      .where(eq(gameProvider.isActive, true))
      .orderBy(asc(gameProvider.name));
    return rows;
  }

  async listProvidersAdmin({
    page,
    limit,
    q,
    isActive,
  }: {
    page: number;
    limit: number;
    q?: string;
    isActive?: boolean;
  }) {
    const where = and(
      q
        ? or(ilike(gameProvider.name, likeContains(q)), ilike(gameProvider.slug, likeContains(q)))
        : undefined,
      isActive === undefined ? undefined : eq(gameProvider.isActive, isActive),
    );
    const [rows, [{ n }]] = await Promise.all([
      this.drizzle.db
        .select()
        .from(gameProvider)
        .where(where)
        .orderBy(asc(gameProvider.name))
        .limit(limit)
        .offset(pageToOffset(page, limit)),
      this.drizzle.db.select({ n: count() }).from(gameProvider).where(where),
    ]);
    return { items: rows.map(toProviderDetail), total: Number(n), page, limit };
  }

  async getProvider(id: string) {
    const record = findOneOrThrow(
      await this.drizzle.db.select().from(gameProvider).where(eq(gameProvider.id, id)).limit(1),
      new GameProviderNotFoundError(id),
    );
    return toProviderDetail(record);
  }

  async updateProvider({ id, actorId, ip, userAgent, ...patchInput }: UpdateProviderInput & Actor) {
    const existing = findOneOrThrow(
      await this.drizzle.db.select().from(gameProvider).where(eq(gameProvider.id, id)).limit(1),
      new GameProviderNotFoundError(id),
    );
    if (patchInput.slug !== undefined && patchInput.slug !== existing.slug) {
      const [clash] = await this.drizzle.db
        .select({ id: gameProvider.id })
        .from(gameProvider)
        .where(and(eq(gameProvider.slug, patchInput.slug), ne(gameProvider.id, id)))
        .limit(1);
      if (clash) {
        throw new GameProviderSlugTakenError();
      }
    }
    const patch: Partial<typeof gameProvider.$inferInsert> = { ...patchInput };
    const hasChanges = Object.values(patch).some((value) => value !== undefined);
    if (!hasChanges) {
      return toProviderDetail(existing);
    }
    let updated: typeof gameProvider.$inferSelect;
    try {
      updated = findOneOrThrow(
        await this.drizzle.db
          .update(gameProvider)
          .set(patch)
          .where(eq(gameProvider.id, id))
          .returning(),
        new GameProviderNotFoundError(id),
      );
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        throw new GameProviderSlugTakenError();
      }
      throw error;
    }
    this.events.emit('gaming.provider.updated', {
      providerId: updated.id,
      actorId,
      before: { slug: existing.slug, name: existing.name },
      after: { slug: updated.slug, name: updated.name },
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
    return toProviderDetail(updated);
  }
}

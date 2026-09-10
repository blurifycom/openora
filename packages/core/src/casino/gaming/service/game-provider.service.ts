import {
  type EventBus,
  makeNotFoundError,
  makeConflictError,
  DrizzleService,
  findOneOrThrow,
  likeContains,
  serializeRow,
  pageToOffset,
  uniqueConstraintName,
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
export const GameProviderVendorIdTakenError = makeConflictError(
  'GameProviderVendorIdTakenError',
  'A provider with this aggregator vendor ID already exists',
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

  async getActiveProviderBySlug(slug: string) {
    const record = findOneOrThrow(
      await this.drizzle.db
        .select()
        .from(gameProvider)
        .where(and(eq(gameProvider.slug, slug), eq(gameProvider.isActive, true)))
        .limit(1),
      new GameProviderNotFoundError(slug),
    );
    return toProviderSummary(record);
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
    // The unique index permits multiple NULLs, so only a concrete vendor id can clash.
    if (
      patchInput.aggregatorVendorId !== undefined &&
      patchInput.aggregatorVendorId !== null &&
      patchInput.aggregatorVendorId !== existing.aggregatorVendorId
    ) {
      const [clash] = await this.drizzle.db
        .select({ id: gameProvider.id })
        .from(gameProvider)
        .where(
          and(
            eq(gameProvider.aggregatorVendorId, patchInput.aggregatorVendorId),
            ne(gameProvider.id, id),
          ),
        )
        .limit(1);
      if (clash) {
        throw new GameProviderVendorIdTakenError();
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
      // Translate only the index that actually fired: a vendor-id collision must
      // never surface as a slug conflict, and an unknown 23505 must not lie at all.
      if (uniqueConstraintName(error) === 'game_provider_aggregator_vendor_id_key') {
        throw new GameProviderVendorIdTakenError();
      }
      if (uniqueConstraintName(error) === 'game_provider_slug_key') {
        throw new GameProviderSlugTakenError();
      }
      throw error;
    }
    this.events.emit('gaming.provider.updated', {
      providerId: updated.id,
      actorId,
      before: {
        slug: existing.slug,
        name: existing.name,
        aggregatorVendorId: existing.aggregatorVendorId,
        logoUrl: existing.logoUrl,
        isActive: existing.isActive,
      },
      after: {
        slug: updated.slug,
        name: updated.name,
        aggregatorVendorId: updated.aggregatorVendorId,
        logoUrl: updated.logoUrl,
        isActive: updated.isActive,
      },
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
    return toProviderDetail(updated);
  }
}

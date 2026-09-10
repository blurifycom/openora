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
import type { ClientMeta, GameProviderAggregatorMapping, User } from '@openora/core/contracts';
import { gameProvider, gameProviderAggregatorMapping } from '../schema/index.js';
import type { CreateProviderInput, UpdateProviderInput } from '../contract/index.js';
import { mappingsByProviderIds } from '../../shared/game-catalog.js';

export const GameProviderNotFoundError = makeNotFoundError('GameProvider');
export const GameProviderSlugTakenError = makeConflictError(
  'GameProviderSlugTakenError',
  'A provider with this slug already exists',
);
export const GameProviderVendorIdTakenError = makeConflictError(
  'GameProviderVendorIdTakenError',
  'A provider with this vendor ID already exists for the aggregator',
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

function providerSnapshot(
  record: typeof gameProvider.$inferSelect,
  aggregatorMappings: readonly GameProviderAggregatorMapping[],
) {
  return {
    slug: record.slug,
    name: record.name,
    aggregatorMappings: [...aggregatorMappings],
    logoUrl: record.logoUrl,
    isActive: record.isActive,
  };
}

function toProviderDetail(
  record: typeof gameProvider.$inferSelect,
  aggregatorMappings: readonly GameProviderAggregatorMapping[],
) {
  const dates = serializeRow(record, { dateFields: ['createdAt', 'updatedAt'] });
  return {
    ...toProviderSummary(record),
    aggregatorMappings: [...aggregatorMappings],
    isActive: record.isActive,
    createdAt: dates.createdAt,
    updatedAt: dates.updatedAt,
  };
}

function isMappingConstraint(name: string | null) {
  return (
    name === 'game_provider_aggregator_mapping_provider_aggregator_key' ||
    name === 'game_provider_aggregator_mapping_aggregator_vendor_id_key'
  );
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
    const mappings = await mappingsByProviderIds(
      this.drizzle.db,
      rows.map((row) => row.id),
    );
    return {
      items: rows.map((row) => toProviderDetail(row, mappings.get(row.id) ?? [])),
      total: Number(n),
      page,
      limit,
    };
  }

  async getProvider(id: string) {
    const record = findOneOrThrow(
      await this.drizzle.db.select().from(gameProvider).where(eq(gameProvider.id, id)).limit(1),
      new GameProviderNotFoundError(id),
    );
    const mappings = await mappingsByProviderIds(this.drizzle.db, [record.id]);
    return toProviderDetail(record, mappings.get(record.id) ?? []);
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

  async createProvider({
    slug,
    name,
    aggregatorMappings = [],
    logoUrl,
    actorId,
    ip,
    userAgent,
  }: CreateProviderInput & Actor) {
    let outcome: {
      record: typeof gameProvider.$inferSelect;
      mappings: GameProviderAggregatorMapping[];
    };
    try {
      outcome = await this.drizzle.db.transaction(async (tx) => {
        const [existing] = await tx
          .select({ id: gameProvider.id })
          .from(gameProvider)
          .where(eq(gameProvider.slug, slug))
          .limit(1);
        if (existing) {
          throw new GameProviderSlugTakenError();
        }
        const created = findOneOrThrow(
          await tx
            .insert(gameProvider)
            .values({ slug, name, logoUrl: logoUrl ?? null })
            .returning(),
          new GameProviderNotFoundError(slug),
        );
        if (aggregatorMappings.length > 0) {
          await tx.insert(gameProviderAggregatorMapping).values(
            aggregatorMappings.map((mapping) => ({
              providerId: created.id,
              ...mapping,
            })),
          );
        }
        const mappings = (await mappingsByProviderIds(tx, [created.id])).get(created.id) ?? [];
        return { record: created, mappings };
      });
    } catch (error) {
      const constraint = uniqueConstraintName(error);
      if (constraint === 'game_provider_slug_key') {
        throw new GameProviderSlugTakenError();
      }
      if (isMappingConstraint(constraint)) {
        throw new GameProviderVendorIdTakenError();
      }
      throw error;
    }
    const snapshot = providerSnapshot(outcome.record, outcome.mappings);
    this.events.emit('gaming.provider.created', {
      providerId: outcome.record.id,
      ...snapshot,
      actorId,
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
    return toProviderDetail(outcome.record, outcome.mappings);
  }

  async updateProvider({
    id,
    actorId,
    ip,
    userAgent,
    aggregatorMappings,
    ...patchInput
  }: UpdateProviderInput & Actor) {
    const outcome = await this.drizzle.db
      .transaction(async (tx) => {
        const existing = findOneOrThrow(
          await tx
            .select()
            .from(gameProvider)
            .where(eq(gameProvider.id, id))
            .limit(1)
            .for('update'),
          new GameProviderNotFoundError(id),
        );
        const existingMappings = (await mappingsByProviderIds(tx, [id])).get(existing.id) ?? [];
        if (patchInput.slug !== undefined && patchInput.slug !== existing.slug) {
          const [clash] = await tx
            .select({ id: gameProvider.id })
            .from(gameProvider)
            .where(and(eq(gameProvider.slug, patchInput.slug), ne(gameProvider.id, id)))
            .limit(1);
          if (clash) {
            throw new GameProviderSlugTakenError();
          }
        }
        const patch: Partial<typeof gameProvider.$inferInsert> = { ...patchInput };
        const hasProviderChanges = Object.values(patch).some((value) => value !== undefined);
        const replaceMappings = aggregatorMappings !== undefined;
        if (!hasProviderChanges && !replaceMappings) {
          const snapshot = providerSnapshot(existing, existingMappings);
          return {
            changed: false,
            before: snapshot,
            after: snapshot,
            result: toProviderDetail(existing, existingMappings),
          };
        }
        const next = findOneOrThrow(
          await tx
            .update(gameProvider)
            .set(replaceMappings ? { ...patch, updatedAt: new Date() } : patch)
            .where(eq(gameProvider.id, id))
            .returning(),
          new GameProviderNotFoundError(id),
        );
        if (replaceMappings) {
          await tx
            .delete(gameProviderAggregatorMapping)
            .where(eq(gameProviderAggregatorMapping.providerId, id));
          if (aggregatorMappings.length > 0) {
            await tx.insert(gameProviderAggregatorMapping).values(
              aggregatorMappings.map((mapping) => ({
                providerId: id,
                ...mapping,
              })),
            );
          }
        }
        const persistedMappings = replaceMappings
          ? ((await mappingsByProviderIds(tx, [id])).get(id) ?? [])
          : existingMappings;
        return {
          changed: true,
          before: providerSnapshot(existing, existingMappings),
          after: providerSnapshot(next, persistedMappings),
          result: toProviderDetail(next, persistedMappings),
        };
      })
      .catch((error: unknown) => {
        // Translate only the index that actually fired: a vendor-id collision must
        // never surface as a slug conflict, and an unknown 23505 must not lie at all.
        if (isMappingConstraint(uniqueConstraintName(error))) {
          throw new GameProviderVendorIdTakenError();
        }
        if (uniqueConstraintName(error) === 'game_provider_slug_key') {
          throw new GameProviderSlugTakenError();
        }
        throw error;
      });
    if (!outcome.changed) {
      return outcome.result;
    }
    this.events.emit('gaming.provider.updated', {
      providerId: id,
      actorId,
      before: outcome.before,
      after: outcome.after,
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
    return outcome.result;
  }
}

import {
  type EventBus,
  makeConflictError,
  DrizzleService,
  findOneOrThrow,
  isUniqueConstraintViolation,
} from '@openora/core/server';
import { eq, and, asc, inArray, ne } from 'drizzle-orm';
import type { ClientMeta, User } from '@openora/core/contracts';
import { game, gameCategory, gameCategoryGame, gameProvider } from '../schema/index.js';
import { GameNotFoundError } from './gaming.service.js';
import { GameProviderNotFoundError, toProviderSummary } from './game-provider.service.js';
import { GameCategoryNotFoundError, toCategorySummary } from './game-category.service.js';
import type { UpdateGameInput } from '../contract/index.js';

export const GameSlugTakenError = makeConflictError(
  'GameSlugTakenError',
  'A game with this slug already exists',
);

type Actor = {
  actorId?: User['id'];
} & ClientMeta;

function toGameDetail(row: {
  game: typeof game.$inferSelect;
  provider: typeof gameProvider.$inferSelect;
  categories: (typeof gameCategory.$inferSelect)[];
}) {
  return {
    id: row.game.id,
    name: row.game.name,
    slug: row.game.slug,
    provider: toProviderSummary(row.provider),
    aggregator: row.game.aggregator,
    categories: row.categories.map(toCategorySummary),
    gameType: row.game.gameType,
    thumbnailUrl: row.game.thumbnailUrl,
    isActive: row.game.isActive,
    metadata: row.game.metadata,
  };
}

export class GameCatalogService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
  ) {}

  async updateGame({
    id,
    categoryIds,
    actorId,
    ip,
    userAgent,
    ...patchInput
  }: UpdateGameInput & Actor) {
    if (patchInput.providerId !== undefined) {
      findOneOrThrow(
        await this.drizzle.db
          .select({ id: gameProvider.id })
          .from(gameProvider)
          .where(eq(gameProvider.id, patchInput.providerId))
          .limit(1),
        new GameProviderNotFoundError(patchInput.providerId),
      );
    }
    if (patchInput.slug !== undefined) {
      const [clash] = await this.drizzle.db
        .select({ id: game.id })
        .from(game)
        .where(and(eq(game.slug, patchInput.slug), ne(game.id, id)))
        .limit(1);
      if (clash) {
        throw new GameSlugTakenError();
      }
    }
    if (categoryIds !== undefined) {
      const rows =
        categoryIds.length > 0
          ? await this.drizzle.db
              .select()
              .from(gameCategory)
              .where(inArray(gameCategory.id, categoryIds))
          : [];
      const found = new Set(rows.map((r) => r.id));
      const missing = categoryIds.find((categoryId) => !found.has(categoryId));
      if (missing) {
        throw new GameCategoryNotFoundError(missing);
      }
    }
    try {
      await this.drizzle.db.transaction(async (tx) => {
        findOneOrThrow(
          await tx.select({ id: game.id }).from(game).where(eq(game.id, id)).limit(1),
          new GameNotFoundError(id),
        );
        const { name, slug, providerId, aggregator, thumbnailUrl, isActive, metadata } = patchInput;
        const patch: Partial<typeof game.$inferInsert> = {
          name,
          slug,
          providerId,
          aggregator,
          thumbnailUrl,
          isActive,
          metadata,
        };
        if (Object.values(patch).some((value) => value !== undefined)) {
          await tx.update(game).set(patch).where(eq(game.id, id));
        }
        if (categoryIds !== undefined) {
          await tx.delete(gameCategoryGame).where(eq(gameCategoryGame.gameId, id));
          if (categoryIds.length > 0) {
            await tx
              .insert(gameCategoryGame)
              .values(categoryIds.map((categoryId) => ({ gameId: id, categoryId })));
          }
        }
      });
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        throw new GameSlugTakenError();
      }
      throw error;
    }
    this.events.emit('gaming.game.updated', {
      gameId: id,
      actorId,
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
    return this.readGame(id);
  }

  private async readGame(id: string) {
    const row = findOneOrThrow(
      await this.drizzle.db
        .select({ game, provider: gameProvider })
        .from(game)
        .innerJoin(gameProvider, eq(game.providerId, gameProvider.id))
        .where(eq(game.id, id)),
      new GameNotFoundError(id),
    );
    const links = await this.drizzle.db
      .select({ category: gameCategory })
      .from(gameCategoryGame)
      .innerJoin(gameCategory, eq(gameCategoryGame.categoryId, gameCategory.id))
      .where(eq(gameCategoryGame.gameId, id))
      .orderBy(asc(gameCategory.sortOrder), asc(gameCategory.name));
    return toGameDetail({ ...row, categories: links.map((l) => l.category) });
  }
}

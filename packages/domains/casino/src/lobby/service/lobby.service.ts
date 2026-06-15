import { createDomainError } from '@oss/core';
import { DrizzleService, findOneOrThrow } from '@oss/db';
import { eq, and, ilike, count, asc, inArray } from 'drizzle-orm';
import { lobbyCategory, lobbyCategoryGame, featuredSlot } from '../schema/index.js';
import { game } from '../../gaming/schema/index.js';
import type {
  LobbyCategory,
  LobbyCategoryDetail,
  FeaturedSlot,
  GameSummary,
} from '../schemas/index.js';

export const LobbyCategoryNotFoundError = createDomainError(
  'LobbyCategoryNotFoundError',
  (slug: string) => `Lobby category not found: ${slug}`,
);

function toGameSummary(record: {
  id: string;
  name: string;
  provider: string;
  category: string;
  thumbnailUrl: string | null;
}): GameSummary {
  return {
    id: record.id,
    name: record.name,
    provider: record.provider,
    category: record.category,
    thumbnailUrl: record.thumbnailUrl,
  };
}

export class LobbyService {
  constructor(private readonly drizzle: DrizzleService) {}

  async listCategories(tenantId?: string): Promise<LobbyCategory[]> {
    const db = this.drizzle.db;
    const [categories, counts] = await Promise.all([
      db
        .select()
        .from(lobbyCategory)
        .where(tenantId ? eq(lobbyCategory.tenantId, tenantId) : undefined)
        .orderBy(asc(lobbyCategory.sortOrder)),
      db
        .select({ categoryId: lobbyCategoryGame.categoryId, n: count() })
        .from(lobbyCategoryGame)
        .groupBy(lobbyCategoryGame.categoryId),
    ]);

    const countMap = new Map(counts.map((r) => [r.categoryId, Number(r.n)]));

    return categories.map((cat) => ({
      id: cat.id,
      name: cat.name,
      slug: cat.slug,
      sortOrder: cat.sortOrder,
      gameCount: countMap.get(cat.id) ?? 0,
    }));
  }

  async getCategoryGames(slug: string, tenantId?: string): Promise<LobbyCategoryDetail> {
    const db = this.drizzle.db;
    const whereClause = tenantId
      ? and(eq(lobbyCategory.tenantId, tenantId), eq(lobbyCategory.slug, slug))
      : eq(lobbyCategory.slug, slug);

    const category = findOneOrThrow(
      await db.select().from(lobbyCategory).where(whereClause),
      new LobbyCategoryNotFoundError(slug),
    );

    const links = await db
      .select()
      .from(lobbyCategoryGame)
      .where(eq(lobbyCategoryGame.categoryId, category.id))
      .orderBy(asc(lobbyCategoryGame.sortOrder));

    const gameIds = links.map((l) => l.gameId);

    const games =
      gameIds.length > 0 ? await db.select().from(game).where(inArray(game.id, gameIds)) : [];

    const gameMap = new Map(games.map((g) => [g.id, g]));

    return {
      id: category.id,
      name: category.name,
      slug: category.slug,
      games: gameIds
        .map((id) => gameMap.get(id))
        .filter((g): g is typeof game.$inferSelect => g !== undefined)
        .map(toGameSummary),
    };
  }

  async getFeatured(tenantId?: string): Promise<FeaturedSlot[]> {
    const db = this.drizzle.db;
    const whereClause = tenantId
      ? and(eq(featuredSlot.isActive, true), eq(featuredSlot.tenantId, tenantId))
      : eq(featuredSlot.isActive, true);

    const slots = await db
      .select()
      .from(featuredSlot)
      .where(whereClause)
      .orderBy(asc(featuredSlot.placement), asc(featuredSlot.sortOrder));

    const gameIds = [...new Set(slots.map((s) => s.gameId))];
    const games =
      gameIds.length > 0 ? await db.select().from(game).where(inArray(game.id, gameIds)) : [];

    const gameMap = new Map(games.map((g) => [g.id, g]));

    return slots.map((slot) => {
      const g = gameMap.get(slot.gameId);
      return {
        id: slot.id,
        title: slot.title,
        gameId: slot.gameId,
        gameName: g?.name ?? '',
        thumbnailUrl: g?.thumbnailUrl ?? null,
        placement: slot.placement,
        sortOrder: slot.sortOrder,
      };
    });
  }

  async search(query: string, tenantId?: string): Promise<GameSummary[]> {
    const db = this.drizzle.db;
    const whereClause = tenantId
      ? and(ilike(game.name, `%${query}%`), eq(game.isActive, true), eq(game.tenantId, tenantId))
      : and(ilike(game.name, `%${query}%`), eq(game.isActive, true));

    const games = await db.select().from(game).where(whereClause).orderBy(asc(game.name)).limit(50);

    return games.map(toGameSummary);
  }
}

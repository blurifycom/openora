import { createDomainError } from '@oss/core';
import { DrizzleService } from '@oss/db';
import { eq, and, ilike, count, asc, inArray } from 'drizzle-orm';
import { lobbyCategory, lobbyCategoryGame, featuredSlot } from '../schema/index.js';
import { game } from '@oss/modules/player/gaming/schema';
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
    const categories = await db
      .select()
      .from(lobbyCategory)
      .where(tenantId ? eq(lobbyCategory.tenantId, tenantId) : undefined)
      .orderBy(asc(lobbyCategory.sortOrder));

    return Promise.all(
      categories.map(async (cat) => {
        const [{ n }] = await db
          .select({ n: count() })
          .from(lobbyCategoryGame)
          .where(eq(lobbyCategoryGame.categoryId, cat.id));
        return {
          id: cat.id,
          name: cat.name,
          slug: cat.slug,
          sortOrder: cat.sortOrder,
          gameCount: Number(n),
        };
      }),
    );
  }

  async getCategoryGames(slug: string, tenantId?: string): Promise<LobbyCategoryDetail> {
    const db = this.drizzle.db;
    const whereClause = tenantId
      ? and(eq(lobbyCategory.tenantId, tenantId), eq(lobbyCategory.slug, slug))
      : eq(lobbyCategory.slug, slug);

    const [category] = await db.select().from(lobbyCategory).where(whereClause);
    if (!category) throw new LobbyCategoryNotFoundError(slug);

    const links = await db
      .select()
      .from(lobbyCategoryGame)
      .where(eq(lobbyCategoryGame.categoryId, category.id))
      .orderBy(asc(lobbyCategoryGame.sortOrder));

    const gameIds = links.map((l) => l.gameId);

    const games =
      gameIds.length > 0
        ? await db.select().from(game).where(inArray(game.id, gameIds))
        : [];

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
      gameIds.length > 0
        ? await db.select().from(game).where(inArray(game.id, gameIds))
        : [];

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

    const games = await db
      .select()
      .from(game)
      .where(whereClause)
      .orderBy(asc(game.name))
      .limit(50);

    return games.map(toGameSummary);
  }
}

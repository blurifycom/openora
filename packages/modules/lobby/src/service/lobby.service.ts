import { Injectable } from '@nestjs/common';
import { PrismaService } from '@oss/persistence';
import type {
  LobbyCategory,
  LobbyCategoryDetail,
  FeaturedSlot,
  GameSummary,
} from '../schemas/index.js';

export class LobbyCategoryNotFoundError extends Error {
  constructor(slug: string) {
    super(`Lobby category not found: ${slug}`);
    this.name = 'LobbyCategoryNotFoundError';
  }
}

type RawGame = {
  id: string;
  name: string;
  provider: string;
  category: string;
  thumbnailUrl: string | null;
};

type RawCategory = {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  sortOrder: number;
};

type RawFeaturedSlot = {
  id: string;
  title: string;
  gameId: string;
  placement: string;
  sortOrder: number;
};

type RawCategoryGame = {
  gameId: string;
};

function toGameSummary(record: RawGame): GameSummary {
  return {
    id: record.id,
    name: record.name,
    provider: record.provider,
    category: record.category,
    thumbnailUrl: record.thumbnailUrl,
  };
}

// oxlint-disable-next-line typescript/no-explicit-any
function db(prisma: PrismaService): any {
  return prisma;
}

@Injectable()
export class LobbyService {
  constructor(private readonly prisma: PrismaService) {}

  async listCategories(tenantId?: string): Promise<LobbyCategory[]> {
    // oxlint-disable-next-line typescript/no-explicit-any
    const categories: RawCategory[] = await db(this.prisma).lobbyCategory.findMany({
      where: tenantId ? { tenantId } : {},
      orderBy: { sortOrder: 'asc' },
    });

    return Promise.all(
      categories.map(async (cat) => {
        // oxlint-disable-next-line typescript/no-explicit-any
        const gameCount: number = await db(this.prisma).lobbyCategoryGame.count({
          where: { categoryId: cat.id },
        });
        return {
          id: cat.id,
          name: cat.name,
          slug: cat.slug,
          sortOrder: cat.sortOrder,
          gameCount,
        };
      }),
    );
  }

  async getCategoryGames(slug: string, tenantId?: string): Promise<LobbyCategoryDetail> {
    const whereClause = tenantId ? { tenantId_slug: { tenantId, slug } } : { slug };
    // oxlint-disable-next-line typescript/no-explicit-any
    const category: RawCategory | null = await db(this.prisma).lobbyCategory.findUnique({
      where: whereClause,
    });

    if (!category) throw new LobbyCategoryNotFoundError(slug);

    // oxlint-disable-next-line typescript/no-explicit-any
    const links: RawCategoryGame[] = await db(this.prisma).lobbyCategoryGame.findMany({
      where: { categoryId: category.id },
      orderBy: { sortOrder: 'asc' },
    });

    const gameIds = links.map((l) => l.gameId);

    const games: RawGame[] =
      gameIds.length > 0
        ? // oxlint-disable-next-line typescript/no-explicit-any
          await db(this.prisma).game.findMany({ where: { id: { in: gameIds } } })
        : [];

    const gameMap = new Map(games.map((g) => [g.id, g]));

    return {
      id: category.id,
      name: category.name,
      slug: category.slug,
      games: gameIds
        .map((id) => gameMap.get(id))
        .filter((g): g is RawGame => g !== undefined)
        .map(toGameSummary),
    };
  }

  async getFeatured(tenantId?: string): Promise<FeaturedSlot[]> {
    const slots: RawFeaturedSlot[] =
      // oxlint-disable-next-line typescript/no-explicit-any
      await db(this.prisma).featuredSlot.findMany({
        where: {
          isActive: true,
          ...(tenantId ? { tenantId } : {}),
        },
        orderBy: [{ placement: 'asc' }, { sortOrder: 'asc' }],
      });

    const gameIds = [...new Set(slots.map((s) => s.gameId))];
    const games: RawGame[] =
      gameIds.length > 0
        ? // oxlint-disable-next-line typescript/no-explicit-any
          await db(this.prisma).game.findMany({ where: { id: { in: gameIds } } })
        : [];

    const gameMap = new Map(games.map((g) => [g.id, g]));

    return slots.map((slot) => {
      const game = gameMap.get(slot.gameId);
      return {
        id: slot.id,
        title: slot.title,
        gameId: slot.gameId,
        gameName: game?.name ?? '',
        thumbnailUrl: game?.thumbnailUrl ?? null,
        placement: slot.placement,
        sortOrder: slot.sortOrder,
      };
    });
  }

  async search(query: string, tenantId?: string): Promise<GameSummary[]> {
    const games: RawGame[] =
      // oxlint-disable-next-line typescript/no-explicit-any
      await db(this.prisma).game.findMany({
        where: {
          name: { contains: query, mode: 'insensitive' },
          isActive: true,
          ...(tenantId ? { tenantId } : {}),
        },
        orderBy: { name: 'asc' },
        take: 50,
      });

    return games.map(toGameSummary);
  }
}

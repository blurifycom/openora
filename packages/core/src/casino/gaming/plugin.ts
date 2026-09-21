import { EVENT_BUS, DRIZZLE, ADMIN_GUARD } from '@openora/core/server';
import type { CoreTokenCatalog, Plugin, TypedContainer } from '@openora/core/server';
import {
  ADMIN_GAME_REPORTING,
  GAME_ADAPTER,
  GAME_CATALOG_READER,
  GAME_GEO_CHECK,
  GAME_SORT_CATALOG,
  GAMING_COMMANDS,
  IDENTITY_READER,
  JOB_QUEUE,
  PLAY_ELIGIBILITY,
  RG_LIMITS,
  RNG_ADAPTER,
  WALLET_COMMANDS,
  createGameSortCatalog,
} from '@openora/core/contracts';
import { createDefaultGameSorts } from './adapters/sort/index.js';
import { GamingService } from './service/gaming.service.js';
import { GameCategoryService } from './service/game-category.service.js';
import { GameSortRankingService } from './service/game-sort-ranking.service.js';
import { GameSortService } from './service/game-sort.service.js';
import { GameSortTriggerService } from './service/game-sort-trigger.service.js';
import { GameTagService } from './service/game-tag.service.js';
import { GameProviderService } from './service/game-provider.service.js';
import { GameBulkService } from './service/game-bulk.service.js';
import { createGamingRouter } from './router/index.js';
import { MockGameAdapter } from './adapters/mock/mock-game-adapter.js';
import { MockRngAdapter } from './adapters/mock/mock-rng-adapter.js';
import { DrizzleAdminGameReporting } from './admin-reporting.js';
import { GameCatalogReaderService } from './adapters/game-catalog-reader.service.js';
import {
  GAME_CATEGORY_RANK_QUEUE,
  GAME_CATEGORY_RANK_SWEEP_QUEUE,
  GameCategoryRankJobSchema,
  GameCategoryRankSweepJobSchema,
} from './contract/index.js';

export default {
  id: 'gaming',
  requiresPorts: [PLAY_ELIGIBILITY, IDENTITY_READER],
  dependsOn: ['wallet'],
  register(ctx) {
    ctx.provide(GAME_ADAPTER, () => new MockGameAdapter());
    ctx.provide(RNG_ADAPTER, () => new MockRngAdapter());
    ctx.provide(ADMIN_GAME_REPORTING, (c) => new DrizzleAdminGameReporting(c.get(DRIZZLE)));
    ctx.provide(GAME_CATALOG_READER, (c) => new GameCatalogReaderService(c.get(DRIZZLE)));
    // Replaceable (not sealed): an overlay can rebind this to add or remove sort
    // definitions - eg an attribute or stats sort - without touching this module.
    ctx.provide(GAME_SORT_CATALOG, (c) =>
      createGameSortCatalog(createDefaultGameSorts(c.get(DRIZZLE))),
    );

    // One memoized instance backs both the router and the GAMING_COMMANDS port.
    let svc: GamingService | null = null;
    const gamingService = (c: TypedContainer<CoreTokenCatalog>) =>
      (svc ??= new GamingService(
        c.get(DRIZZLE),
        c.get(EVENT_BUS),
        c.get(GAME_ADAPTER),
        c.get(PLAY_ELIGIBILITY),
        c.get(WALLET_COMMANDS),
        c.get(IDENTITY_READER),
        c.has(RG_LIMITS) ? c.get(RG_LIMITS) : undefined,
        c.has(GAME_GEO_CHECK) ? c.get(GAME_GEO_CHECK) : undefined,
      ));

    let rankingRef: GameSortRankingService | null = null;
    let triggersRef: GameSortTriggerService | null = null;
    const requireTriggers = () => {
      if (!triggersRef) {
        throw new Error('gaming: sort trigger service not constructed yet');
      }
      return triggersRef;
    };

    ctx.events.on('gaming.game.updated', (payload) => requireTriggers().gameUpdated(payload));
    ctx.events.on('gaming.games.bulk_updated', (payload) =>
      requireTriggers().gamesBulkUpdated(payload),
    );
    ctx.events.on('gaming.provider.updated', (payload) =>
      requireTriggers().providerUpdated(payload),
    );
    ctx.events.on('gaming.game.availability_changed', (payload) =>
      requireTriggers().gameAvailabilityChanged(payload),
    );

    ctx.jobs.worker({
      queue: GAME_CATEGORY_RANK_QUEUE,
      schema: GameCategoryRankJobSchema,
      handler: async ({ payload }) => {
        if (!rankingRef) {
          throw new Error('gaming: ranking service not constructed yet');
        }
        await rankingRef.rank(payload.categoryId);
      },
    });

    ctx.jobs.worker({
      queue: GAME_CATEGORY_RANK_SWEEP_QUEUE,
      schema: GameCategoryRankSweepJobSchema,
      handler: async () => requireTriggers().sweep(),
    });

    ctx.routers.add('gaming', (c) => {
      const jobQueue = c.get(JOB_QUEUE);
      const sorts = new GameSortService(c.get(GAME_SORT_CATALOG));
      rankingRef = new GameSortRankingService(c.get(DRIZZLE), sorts);
      triggersRef = new GameSortTriggerService(c.get(DRIZZLE), jobQueue);
      triggersRef.scheduleSweep();
      return createGamingRouter({
        gaming: gamingService(c),
        providers: new GameProviderService(c.get(DRIZZLE), c.get(EVENT_BUS)),
        categories: new GameCategoryService(c.get(DRIZZLE), c.get(EVENT_BUS), jobQueue, sorts),
        tags: new GameTagService(c.get(DRIZZLE), c.get(EVENT_BUS)),
        bulk: new GameBulkService(c.get(DRIZZLE), c.get(EVENT_BUS)),
        adminGuard: c.get(ADMIN_GUARD),
        sorts,
      });
    });
    ctx.provide(GAMING_COMMANDS, (c) => ({
      accumulateExternalRound: (tx, args) => gamingService(c).accumulateExternalRound(tx, args),
      setGameAvailability: (args) => gamingService(c).setGameAvailability(args),
    }));
  },
} as const satisfies Plugin<CoreTokenCatalog>;

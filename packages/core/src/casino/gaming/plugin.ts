import { EVENT_BUS, DRIZZLE, ADMIN_GUARD, createLogger } from '@openora/core/server';
import type {
  CoreTokenCatalog,
  DrizzleService,
  Plugin,
  TypedContainer,
} from '@openora/core/server';
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
  domainEventSchemas,
  type JobQueueAdapter,
} from '@openora/core/contracts';
import { createDefaultGameSorts } from './adapters/sort/index.js';
import {
  categoryIdsForGameIds,
  categoryIdsForProviderIds,
  categoryRankTriggerIds,
} from '../shared/game-catalog.js';
import { GamingService } from './service/gaming.service.js';
import { GameCategoryService } from './service/game-category.service.js';
import {
  GameSortRankingService,
  enqueueGameCategoryRank,
} from './service/game-sort-ranking.service.js';
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
  RANK_SWEEP_INTERVAL_MS,
} from './contract/index.js';

const logger = createLogger('gaming');

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

    // svcRefs are null at registration (subscriptions wire before router factories run)
    // but set before any real event/job arrives. See create-app.ts boot order. A ref
    // still null when a trigger actually fires is a boot-order bug, not a quiet no-op -
    // every call site below throws rather than silently skip the rank (mirrors mail's
    // job handler in mail/plugin.ts).
    let jobQueueRef: JobQueueAdapter | null = null;
    let rankingRef: GameSortRankingService | null = null;
    let drizzleRef: DrizzleService | null = null;

    const enqueueRank = (categoryId: string) => {
      if (!jobQueueRef) {
        throw new Error('gaming: job queue not resolved yet - cannot enqueue a category rank');
      }
      enqueueGameCategoryRank(jobQueueRef, categoryId);
    };
    const enqueueRankForCategories = (categoryIds: readonly string[]) => {
      for (const categoryId of categoryIds) {
        enqueueRank(categoryId);
      }
    };
    const requireDb = () => {
      if (!drizzleRef) {
        throw new Error('gaming: drizzle not resolved yet - cannot resolve affected categories');
      }
      return drizzleRef.db;
    };
    // Shared by every fast-path handler below that must look up affected categories
    // before it can enqueue: resolve, enqueue what came back, log and drop a lookup
    // failure rather than let it become an unhandled rejection - each fast path is a
    // pure optimization, backstopped by the durable rankDirtyAt + sweep the service
    // layer already sets transactionally. See docs/modules/gaming.md.
    const enqueueRankForLookup = (lookup: Promise<string[]>, errorContext: string) => {
      void lookup.then(enqueueRankForCategories).catch((err: unknown) => {
        logger.error({ err }, `${errorContext} rank-trigger lookup failed`);
      });
    };

    ctx.events.on('gaming.game.updated', (payload) => {
      const parsed = domainEventSchemas['gaming.game.updated'].safeParse(payload);
      if (!parsed.success) {
        return;
      }
      enqueueRankForCategories(categoryRankTriggerIds(parsed.data.before, parsed.data.after));
    });

    ctx.events.on('gaming.games.bulk_updated', (payload) => {
      const parsed = domainEventSchemas['gaming.games.bulk_updated'].safeParse(payload);
      if (!parsed.success) {
        return;
      }
      if (parsed.data.operation === 'add_categories') {
        enqueueRankForCategories(parsed.data.categoryIds);
        return;
      }
      if (parsed.data.operation === 'set_active') {
        // The service already resolved this in-transaction for the dirty marker and
        // carries it on the event - only an event queued before that field existed
        // (absent here) falls back to resolving it again.
        if (parsed.data.affectedCategoryIds !== undefined) {
          enqueueRankForCategories(parsed.data.affectedCategoryIds);
          return;
        }
        const db = requireDb();
        enqueueRankForLookup(
          Promise.all([
            categoryIdsForGameIds(db, parsed.data.changedGameIds),
            categoryIdsForProviderIds(db, parsed.data.changedProviderIds),
          ]).then(([byGame, byProvider]) => [...new Set([...byGame, ...byProvider])]),
          'gaming.games.bulk_updated (set_active)',
        );
      }
    });

    // Fast paths for a playability flip that a plain membership/name trigger above never
    // sees: a provider's own isActive flip, and a game's vendor-availability flip.
    ctx.events.on('gaming.provider.updated', (payload) => {
      const parsed = domainEventSchemas['gaming.provider.updated'].safeParse(payload);
      if (!parsed.success || parsed.data.before.isActive === parsed.data.after.isActive) {
        return;
      }
      enqueueRankForLookup(
        categoryIdsForProviderIds(requireDb(), [parsed.data.providerId]),
        'gaming.provider.updated',
      );
    });

    ctx.events.on('gaming.game.availability_changed', (payload) => {
      const parsed = domainEventSchemas['gaming.game.availability_changed'].safeParse(payload);
      if (!parsed.success || parsed.data.before.isUnavailable === parsed.data.after.isUnavailable) {
        return;
      }
      enqueueRankForLookup(
        categoryIdsForGameIds(requireDb(), [parsed.data.gameId]),
        'gaming.game.availability_changed',
      );
    });

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
      handler: async () => {
        if (!rankingRef) {
          throw new Error('gaming: ranking service not constructed yet');
        }
        await rankingRef.sweep();
      },
    });

    ctx.routers.add('gaming', (c) => {
      jobQueueRef = c.get(JOB_QUEUE);
      drizzleRef = c.get(DRIZZLE);
      const sortCatalog = c.get(GAME_SORT_CATALOG);
      rankingRef = new GameSortRankingService(c.get(DRIZZLE), sortCatalog, jobQueueRef);
      void jobQueueRef
        .schedule(
          GAME_CATEGORY_RANK_SWEEP_QUEUE,
          'gaming-category-rank-sweep',
          {},
          {
            everyMs: RANK_SWEEP_INTERVAL_MS,
          },
        )
        .catch((err: unknown) => {
          logger.error({ err }, 'gaming.category.rank-sweep schedule failed');
        });
      return createGamingRouter({
        gaming: gamingService(c),
        providers: new GameProviderService(c.get(DRIZZLE), c.get(EVENT_BUS)),
        categories: new GameCategoryService(
          c.get(DRIZZLE),
          c.get(EVENT_BUS),
          jobQueueRef,
          sortCatalog,
        ),
        tags: new GameTagService(c.get(DRIZZLE), c.get(EVENT_BUS)),
        bulk: new GameBulkService(c.get(DRIZZLE), c.get(EVENT_BUS)),
        adminGuard: c.get(ADMIN_GUARD),
        sortCatalog,
      });
    });
    ctx.provide(GAMING_COMMANDS, (c) => ({
      accumulateExternalRound: (tx, args) => gamingService(c).accumulateExternalRound(tx, args),
      setGameAvailability: (args) => gamingService(c).setGameAvailability(args),
    }));
  },
} as const satisfies Plugin<CoreTokenCatalog>;

import { EVENT_BUS, DRIZZLE } from '@openora/core/server';
import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import {
  ADMIN_GAME_REPORTING,
  GAME_ADAPTER,
  PLAY_ELIGIBILITY,
  RNG_ADAPTER,
  WALLET_COMMANDS,
} from '@openora/core/contracts';
import { GamingService } from './service/gaming.service.js';
import { createGamingRouter } from './router/index.js';
import { MockGameAdapter } from './adapters/mock/mock-game-adapter.js';
import { MockRngAdapter } from './adapters/mock/mock-rng-adapter.js';
import { DrizzleAdminGameReporting } from './admin-reporting.js';

export default {
  id: 'gaming',
  requiresPorts: [PLAY_ELIGIBILITY],
  dependsOn: ['wallet'],
  register(ctx) {
    ctx.provide(GAME_ADAPTER, () => new MockGameAdapter());
    ctx.provide(RNG_ADAPTER, () => new MockRngAdapter());
    ctx.provide(ADMIN_GAME_REPORTING, (c) => new DrizzleAdminGameReporting(c.get(DRIZZLE)));
    ctx.routers.add('gaming', (c) =>
      createGamingRouter(
        new GamingService(
          c.get(DRIZZLE),
          c.get(EVENT_BUS),
          c.get(GAME_ADAPTER),
          c.get(PLAY_ELIGIBILITY),
          c.get(WALLET_COMMANDS),
        ),
      ),
    );
  },
} as const satisfies Plugin<CoreTokenCatalog>;

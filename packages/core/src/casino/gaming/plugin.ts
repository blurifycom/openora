import { EVENT_BUS, DRIZZLE } from '@openora/core/server';
import type { CoreTokenCatalog, Plugin, TypedContainer } from '@openora/core/server';
import {
  ADMIN_GAME_REPORTING,
  GAME_ADAPTER,
  GAMING_COMMANDS,
  IDENTITY_READER,
  PLAY_ELIGIBILITY,
  RG_LIMITS,
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
  requiresPorts: [PLAY_ELIGIBILITY, IDENTITY_READER],
  dependsOn: ['wallet'],
  register(ctx) {
    ctx.provide(GAME_ADAPTER, () => new MockGameAdapter());
    ctx.provide(RNG_ADAPTER, () => new MockRngAdapter());
    ctx.provide(ADMIN_GAME_REPORTING, (c) => new DrizzleAdminGameReporting(c.get(DRIZZLE)));

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
      ));

    ctx.routers.add('gaming', (c) => createGamingRouter(gamingService(c)));
    ctx.provide(GAMING_COMMANDS, (c) => ({
      accumulateExternalRound: (tx, args) => gamingService(c).accumulateExternalRound(tx, args),
    }));
  },
} as const satisfies Plugin<CoreTokenCatalog>;

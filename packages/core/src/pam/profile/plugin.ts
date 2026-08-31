import { DRIZZLE } from '@openora/core/server';
import type { CoreTokenCatalog, Plugin, TypedContainer } from '@openora/core/server';
import {
  PLAYER_PROVISIONING,
  WALLET_READER,
  EXCHANGE_RATE_READER,
  AUDIT_WRITER,
  PLATFORM_CONFIG,
  resolveDisplayCurrencies,
} from '@openora/core/contracts';
import { ProfileService } from './service/profile.service.js';
import { createProfileRouter } from './router/index.js';

const makeProfileService = (c: TypedContainer<CoreTokenCatalog>) =>
  new ProfileService(
    c.get(DRIZZLE),
    c.get(WALLET_READER),
    c.get(EXCHANGE_RATE_READER),
    c.get(AUDIT_WRITER),
    resolveDisplayCurrencies(c.get(PLATFORM_CONFIG).displayCurrencies),
  );

export default {
  id: 'profile',
  dependsOn: ['wallet', 'exchange-rate', 'audit'],
  register(ctx) {
    ctx.provide(PLAYER_PROVISIONING, makeProfileService);
    ctx.routers.add('profile', (c) => createProfileRouter(makeProfileService(c)));
  },
} as const satisfies Plugin<CoreTokenCatalog>;

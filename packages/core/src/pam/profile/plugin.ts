import { DRIZZLE } from '@openora/core/server';
import type { CoreTokenCatalog, Plugin, TypedContainer } from '@openora/core/server';
import {
  PLAYER_PROVISIONING,
  WALLET_READER,
  EXCHANGE_RATE_READER,
  AUDIT_WRITER,
  PLATFORM_CONFIG,
  RATE_LIMITER,
  USER_COMMANDS,
  resolveDisplayCurrencies,
} from '@openora/core/contracts';
import { ProfileService } from './service/profile.service.js';
import { createProfileRouter } from './router/index.js';

const makeProfileService = (c: TypedContainer<CoreTokenCatalog>) =>
  new ProfileService({
    drizzle: c.get(DRIZZLE),
    walletReader: c.get(WALLET_READER),
    exchangeRateReader: c.get(EXCHANGE_RATE_READER),
    audit: c.get(AUDIT_WRITER),
    userCommands: c.get(USER_COMMANDS),
    limiter: c.get(RATE_LIMITER),
    supportedDisplayCurrencies: resolveDisplayCurrencies(c.get(PLATFORM_CONFIG).displayCurrencies),
    reservedUsernames: c.get(PLATFORM_CONFIG).reservedUsernames,
  });

export default {
  id: 'profile',
  dependsOn: ['wallet', 'exchange-rate', 'audit', 'identity'],
  register(ctx) {
    ctx.provide(PLAYER_PROVISIONING, makeProfileService);
    ctx.routers.add('profile', (c) => createProfileRouter(makeProfileService(c)));
  },
} as const satisfies Plugin<CoreTokenCatalog>;

import { EVENT_BUS, DRIZZLE, ADMIN_GUARD, createLogger } from '@openora/core/server';
import {
  AUDIT_WRITER,
  KYC_STATUS_WRITER,
  ADMIN_USER_DIRECTORY,
  ADMIN_GAME_REPORTING,
  CHAT_BLOCK_WRITER,
  SESSION_COMMANDS,
  USER_COMMANDS,
  PLAYER_ACTIVITY_TRACKER,
  EXCHANGE_RATE_READER,
  domainEventSchemas,
} from '@openora/core/contracts';
import type { CoreTokenCatalog, Plugin, TypedContainer } from '@openora/core/server';
import { PlayerService } from './service/player.service.js';
import { PlayerKycStatusWriter } from './service/kyc-status-writer.js';
import { createPlayerRouter } from './router/index.js';

function makePlayerService(c: TypedContainer<CoreTokenCatalog>) {
  return new PlayerService(
    c.get(DRIZZLE),
    c.get(EVENT_BUS),
    c.get(ADMIN_USER_DIRECTORY),
    c.get(ADMIN_GAME_REPORTING),
    c.get(CHAT_BLOCK_WRITER),
    c.get(SESSION_COMMANDS),
    c.get(USER_COMMANDS),
    c.has(EXCHANGE_RATE_READER) ? c.get(EXCHANGE_RATE_READER) : undefined,
  );
}

const logger = createLogger('player-management');

export default {
  id: 'player-management',
  dependsOn: ['chat', 'gaming', 'audit', 'identity'],
  register(ctx) {
    // One memoized instance backs the tracker port, the router and the deposit subscription.
    let svc: PlayerService | null = null;
    const playerService = (c: TypedContainer<CoreTokenCatalog>) => (svc ??= makePlayerService(c));

    ctx.events.on('wallet.deposit.completed', (payload) => {
      const parsed = domainEventSchemas['wallet.deposit.completed'].safeParse(payload);
      if (!parsed.success || !svc) {
        return;
      }
      svc
        .refreshTotalDeposits(parsed.data.userId)
        .catch((err) => logger.error({ err }, 'player total deposits refresh failed'));
    });

    ctx.provide(KYC_STATUS_WRITER, (c) => new PlayerKycStatusWriter(c.get(DRIZZLE)));
    ctx.provide(PLAYER_ACTIVITY_TRACKER, playerService);
    ctx.routers.add('player', (c) =>
      createPlayerRouter(playerService(c), c.get(ADMIN_GUARD), c.get(AUDIT_WRITER)),
    );
  },
} as const satisfies Plugin<CoreTokenCatalog>;

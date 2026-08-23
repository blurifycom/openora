import { EVENT_BUS, DRIZZLE, ADMIN_GUARD } from '@openora/core/server';
import {
  AUDIT_WRITER,
  KYC_STATUS_WRITER,
  ADMIN_USER_DIRECTORY,
  ADMIN_GAME_REPORTING,
  CHAT_BLOCK_WRITER,
  SESSION_COMMANDS,
  USER_COMMANDS,
  PLAYER_ACTIVITY_TRACKER,
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
  );
}

export default {
  id: 'player-management',
  dependsOn: ['chat', 'gaming', 'audit', 'identity'],
  register(ctx) {
    ctx.provide(
      KYC_STATUS_WRITER,
      (c) => new PlayerKycStatusWriter(c.get(DRIZZLE), c.get(EVENT_BUS)),
    );
    ctx.provide(PLAYER_ACTIVITY_TRACKER, (c) => makePlayerService(c));
    ctx.routers.add('player', (c) =>
      createPlayerRouter(makePlayerService(c), c.get(ADMIN_GUARD), c.get(AUDIT_WRITER)),
    );
  },
} as const satisfies Plugin<CoreTokenCatalog>;

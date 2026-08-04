import {
  definePlugin,
  EVENT_BUS,
  DRIZZLE,
  ADMIN_GUARD,
  type CoreTokenCatalog,
} from '@openora/core/server';
import { AUDIT_WRITER, KYC_STATUS_WRITER } from '@openora/core/contracts';
import { PlayerService } from './service/player.service.js';
import { PlayerKycStatusWriter } from './service/kyc-status-writer.js';
import { createPlayerRouter } from './router/index.js';

// Owns the player table writes, so it binds the single KYC_STATUS_WRITER seam
// (compliance + the admin override route consume it). Reads identity via /schema. See ADR-0020.
export default definePlugin<CoreTokenCatalog>()({
  id: 'player-management',
  dependsOn: ['audit'],
  register(ctx) {
    ctx.provide(
      KYC_STATUS_WRITER,
      (c) => new PlayerKycStatusWriter(c.get(DRIZZLE), c.get(EVENT_BUS)),
    );
    ctx.routers.add('player', (c) =>
      createPlayerRouter(
        new PlayerService(c.get(DRIZZLE), c.get(EVENT_BUS)),
        c.get(ADMIN_GUARD),
        c.get(AUDIT_WRITER),
      ),
    );
  },
});

import { definePlugin } from '@oss/plugin-host';
import { DRIZZLE } from '@oss/db';
import { ADMIN_GUARD } from '@oss/auth';
import { PlayerService } from './service/player.service.js';
import { createPlayerRouter } from './router/index.js';

// Premium admin PAM surface (admin-guarded). The player-facing self-profile and
// the `player` table live in the core profile module; this package reads that
// table via the /schema subpath. See ADR-0020.
export default definePlugin({
  id: 'player-management',
  register(ctx) {
    ctx.routers.add('player', (c) =>
      createPlayerRouter(new PlayerService(c.get(DRIZZLE)), c.get(ADMIN_GUARD)),
    );
  },
});

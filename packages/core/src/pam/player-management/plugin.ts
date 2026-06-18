import { definePlugin } from '@oss/core/server';
import { EVENT_BUS } from '@oss/core/server';
import { DRIZZLE } from '@oss/core/server';
import { ADMIN_GUARD } from '@oss/core/server';
import { PlayerService } from './service/player.service.js';
import { createPlayerRouter } from './router/index.js';

// Reads the identity table via the /schema subpath. See ADR-0020.
export default definePlugin({
  id: 'player-management',
  register(ctx) {
    ctx.routers.add('player', (c) =>
      createPlayerRouter(new PlayerService(c.get(DRIZZLE), c.get(EVENT_BUS)), c.get(ADMIN_GUARD)),
    );
  },
});

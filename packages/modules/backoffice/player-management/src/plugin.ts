import { definePlugin } from '@oss/plugin-host';
import { DRIZZLE } from '@oss/db';
import { ADMIN_GUARD } from '@oss/auth';
import { PlayerService } from './service/player.service.js';
import { createPlayerRouter } from './router/index.js';

export default definePlugin({
  id: 'player-management',
  register(ctx) {
    ctx.routers.add('player', (c) =>
      createPlayerRouter(new PlayerService(c.get(DRIZZLE)), c.get(ADMIN_GUARD)),
    );
  },
});

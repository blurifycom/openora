import { definePlugin } from '@oss/plugin-host';
import { DRIZZLE } from '@oss/db';
import { ADMIN_GUARD } from '@oss/auth';
import { PlayerService } from './service/player.service.js';
import { createPlayerRouter } from './router/index.js';
import { createProfileRouter } from './router/profile.js';

export default definePlugin({
  id: 'player-management',
  register(ctx) {
    // Admin PAM surface (admin-guarded).
    ctx.routers.add('player', (c) =>
      createPlayerRouter(new PlayerService(c.get(DRIZZLE)), c.get(ADMIN_GUARD)),
    );
    // Player-facing self-profile surface (verified session, not guarded).
    ctx.routers.add('profile', (c) => createProfileRouter(new PlayerService(c.get(DRIZZLE))));
  },
});

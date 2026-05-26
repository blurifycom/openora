import { definePlugin } from '@oss/plugin-host';
import { PlayerService } from './service/player.service.js';
import { PlayerController } from './router/index.js';

export default definePlugin({
  id: 'player-management',
  register(ctx) {
    ctx.providers.add(PlayerService);
    ctx.controllers.add(PlayerController);
  },
});

import { definePlugin } from '@oss/plugin-host';
import { LobbyService } from './service/lobby.service.js';
import { LobbyController } from './router/index.js';

export default definePlugin({
  id: 'lobby',
  register(ctx) {
    ctx.providers.add(LobbyService);
    ctx.controllers.add(LobbyController);
  },
});

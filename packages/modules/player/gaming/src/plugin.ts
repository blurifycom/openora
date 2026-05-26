import { definePlugin } from '@oss/plugin-host';
import { GamingService } from './service/gaming.service.js';
import { GamingController } from './router/index.js';
import { GAME_ADAPTER } from '@oss/adapters';
import { MockGameAdapter } from './adapters/mock/mock-game-adapter.js';

export default definePlugin({
  id: 'gaming',
  register(ctx) {
    ctx.providers.add({
      provide: GAME_ADAPTER,
      useClass: MockGameAdapter,
    });
    ctx.providers.add(GamingService);
    ctx.controllers.add(GamingController);
  },
});

import { definePlugin } from '@oss/plugin-host';
import { GamingService } from './service/gaming.service.js';
import { GamingController } from './router/index.js';
import { MockGameProvider } from './adapters/mock/mock-game-provider.js';
import { GAME_PROVIDER } from './service/ports.js';

export default definePlugin({
  id: 'gaming',
  register(ctx) {
    ctx.providers.add({
      provide: GAME_PROVIDER,
      useClass: MockGameProvider,
    });
    ctx.providers.add(GamingService);
    ctx.controllers.add(GamingController);
  },
});

import { definePlugin } from '@oss/plugin-host';
import { LocalizationService } from './service/localization.service.js';
import { LocalizationController } from './router/index.js';

export default definePlugin({
  id: 'localization',
  register(ctx) {
    ctx.providers.add(LocalizationService);
    ctx.controllers.add(LocalizationController);
  },
});

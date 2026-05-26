import { definePlugin } from '@oss/plugin-host';
import { CmsService } from './service/cms.service.js';
import { CmsController } from './router/index.js';

export default definePlugin({
  id: 'cms',
  register(ctx) {
    ctx.providers.add(CmsService);
    ctx.controllers.add(CmsController);
  },
});

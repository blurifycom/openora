import { definePlugin, EVENT_BUS, DRIZZLE, ADMIN_GUARD } from '@blurifycom/core/server';
import { CACHE } from '@blurifycom/core/contracts';
import { CmsService } from './service/cms.service.js';
import { createCmsRouter } from './router/index.js';

export default definePlugin({
  id: 'cms',
  register(ctx) {
    ctx.routers.add('cms', (c) =>
      createCmsRouter(
        new CmsService(c.get(DRIZZLE), c.get(EVENT_BUS), c.get(CACHE)),
        c.get(ADMIN_GUARD),
      ),
    );
  },
});

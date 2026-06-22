import { definePlugin } from '@blurifycom/core/server';
import { EVENT_BUS } from '@blurifycom/core/server';
import { DRIZZLE } from '@blurifycom/core/server';
import { ADMIN_GUARD } from '@blurifycom/core/server';
import { CmsService } from './service/cms.service.js';
import { createCmsRouter } from './router/index.js';

export default definePlugin({
  id: 'cms',
  register(ctx) {
    ctx.routers.add('cms', (c) =>
      createCmsRouter(new CmsService(c.get(DRIZZLE), c.get(EVENT_BUS)), c.get(ADMIN_GUARD)),
    );
  },
});

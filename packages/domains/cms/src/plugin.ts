import { definePlugin } from '@oss/plugin-host';
import { EVENT_BUS } from '@oss/core';
import { DRIZZLE } from '@oss/db';
import { ADMIN_GUARD } from '@oss/auth';
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

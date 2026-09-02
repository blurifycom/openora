import { EVENT_BUS, DRIZZLE, ADMIN_GUARD } from '@openora/core/server';
import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { CACHE, PLATFORM_CONFIG } from '@openora/core/contracts';
import { CmsService } from './service/cms.service.js';
import { createCmsRouter } from './router/index.js';

export default {
  id: 'cms',
  register(ctx) {
    ctx.routers.add('cms', (c) =>
      createCmsRouter(
        new CmsService(
          c.get(DRIZZLE),
          c.get(EVENT_BUS),
          c.get(CACHE),
          c.has(PLATFORM_CONFIG) ? c.get(PLATFORM_CONFIG).cms.allowedBannerImageHosts : [],
        ),
        c.get(ADMIN_GUARD),
      ),
    );
  },
} as const satisfies Plugin<CoreTokenCatalog>;

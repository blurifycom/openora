import { EVENT_BUS, DRIZZLE, ADMIN_GUARD } from '@openora/core/server';
import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { CACHE, PLATFORM_CONFIG } from '@openora/core/contracts';
import { CmsService } from './service/cms.service.js';
import { CmsBannersService } from './service/cms-banners.service.js';
import { createCmsRouter } from './router/index.js';
import { cmsBannersTool } from './contract/index.js';

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
    // Its own reader over DRIZZLE alone: the kernel builds every tool's handler when it starts.
    ctx.mcp.tool(cmsBannersTool, (c) => {
      const banners = new CmsBannersService(c.get(DRIZZLE));
      return (input) => banners.banners(input);
    });
  },
} as const satisfies Plugin<CoreTokenCatalog>;

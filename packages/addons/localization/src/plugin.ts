import { definePlugin } from '@oss/plugin-host';
import { EVENT_BUS } from '@oss/core';
import { DRIZZLE } from '@oss/db';
import { ADMIN_GUARD } from '@oss/auth';
import { LocalizationService } from './service/localization.service.js';
import { createLocalizationRouter } from './router/index.js';

export default definePlugin({
  id: 'localization',
  register(ctx) {
    ctx.routers.add('localization', (c) =>
      createLocalizationRouter(
        new LocalizationService(c.get(DRIZZLE), c.get(EVENT_BUS)),
        c.get(ADMIN_GUARD),
      ),
    );
  },
});

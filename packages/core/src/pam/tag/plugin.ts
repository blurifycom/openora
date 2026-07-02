import { definePlugin, EVENT_BUS, DRIZZLE } from '@blurifycom/core/server';
import { TagService } from './service/tag.service.js';
import { createTagRouter } from './router/index.js';

export default definePlugin({
  id: 'tag',
  register(ctx) {
    ctx.routers.add('tag', (c) =>
      createTagRouter(new TagService(c.get(DRIZZLE), c.get(EVENT_BUS))),
    );
  },
});

import { definePlugin, EVENT_BUS, DRIZZLE, createLogger } from '@blurifycom/core/server';
import { domainEventSchemas } from '@blurifycom/core/contracts';
import { TagService } from './service/tag.service.js';
import { createTagRouter } from './router/index.js';

const logger = createLogger('tag');

export default definePlugin({
  id: 'tag',
  register(ctx) {
    // tagsRef is null at registration (subscriptions wire before router factories run) but
    // set before any real event arrives - mirrors the compliance plugin's kycRef pattern.
    let tagsRef: TagService | null = null;

    ctx.events.on('compliance.kyc.updated', (payload) => {
      const parsed = domainEventSchemas['compliance.kyc.updated'].safeParse(payload);
      if (!parsed.success || !tagsRef) return;
      tagsRef
        .syncKycStatusTags({
          userId: parsed.data.userId,
          actorId: parsed.data.actorId,
          status: parsed.data.status,
        })
        .catch((err) => logger.error({ err }, 'KYC status tag sync failed'));
    });

    ctx.routers.add('tag', (c) => {
      const svc = new TagService(c.get(DRIZZLE), c.get(EVENT_BUS));
      tagsRef = svc;
      return createTagRouter(svc);
    });
  },
});

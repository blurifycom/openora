import { definePlugin, EVENT_BUS, DRIZZLE } from '@openora/core/server';
import { REALTIME_TRANSPORT, REALTIME_CLIENT_AUTHORIZER } from '@openora/core/contracts';
import { ChatService } from './service/chat.service.js';
import { createChatRouter } from './router/index.js';

export default definePlugin({
  id: 'chat',
  register(ctx) {
    ctx.routers.add('chat', (c) =>
      createChatRouter(
        new ChatService(c.get(DRIZZLE), c.get(EVENT_BUS), c.get(REALTIME_TRANSPORT)),
        c.get(REALTIME_CLIENT_AUTHORIZER),
      ),
    );
  },
});

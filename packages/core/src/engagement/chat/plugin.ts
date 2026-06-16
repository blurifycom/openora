import { definePlugin } from '@oss/core/server';
import { EVENT_BUS } from '@oss/core/server';
import { REALTIME_TRANSPORT, REALTIME_CLIENT_AUTHORIZER } from '@oss/core/contracts';
import { DRIZZLE } from '@oss/core/server';
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

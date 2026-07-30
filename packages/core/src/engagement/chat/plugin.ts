import { definePlugin, EVENT_BUS, DRIZZLE, ADMIN_GUARD } from '@openora/core/server';
import {
  CHAT_REALTIME_TRANSPORT,
  CHAT_REALTIME_CLIENT_AUTHORIZER,
  RATE_LIMITER,
  CHAT_SYSTEM_WRITER,
  CHAT_BLOCK_WRITER,
  createToken,
} from '@openora/core/contracts';
import { ChatService } from './service/chat.service.js';
import { createChatRouter } from './router/index.js';

const CHAT_SERVICE = createToken<ChatService>('_ChatService');

export default definePlugin({
  id: 'chat',
  register(ctx) {
    ctx.provide(
      CHAT_SERVICE,
      (c) => new ChatService(c.get(DRIZZLE), c.get(EVENT_BUS), c.get(CHAT_REALTIME_TRANSPORT)),
    );
    ctx.provide(CHAT_SYSTEM_WRITER, (c) => c.get(CHAT_SERVICE));
    ctx.provide(CHAT_BLOCK_WRITER, (c) => c.get(CHAT_SERVICE));

    ctx.routers.add('chat', (c) =>
      createChatRouter({
        chatService: c.get(CHAT_SERVICE),
        authorizer: c.get(CHAT_REALTIME_CLIENT_AUTHORIZER),
        adminGuard: c.get(ADMIN_GUARD),
        limiter: c.get(RATE_LIMITER),
      }),
    );
  },
});

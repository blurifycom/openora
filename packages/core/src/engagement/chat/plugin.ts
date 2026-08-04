import {
  definePluginWithCatalog,
  EVENT_BUS,
  DRIZZLE,
  ADMIN_GUARD,
  type CoreTokenCatalog,
  type TypedContainer,
} from '@openora/core/server';
import {
  CHAT_REALTIME_TRANSPORT,
  CHAT_REALTIME_CLIENT_AUTHORIZER,
  RATE_LIMITER,
  CHAT_SYSTEM_WRITER,
  CHAT_BLOCK_WRITER,
  CHAT_ROOM_ACCESS,
  ADMIN_USER_DIRECTORY,
  REALTIME_TRANSPORT,
  REALTIME_CLIENT_AUTHORIZER,
} from '@openora/core/contracts';
import { ChatService } from './service/chat.service.js';
import { createChatRouter } from './router/index.js';

export default definePluginWithCatalog<CoreTokenCatalog>()({
  id: 'chat',
  dependsOn: ['identity'],
  register(ctx) {
    let chatService: ChatService | null = null;
    const getChatService = (container: TypedContainer<CoreTokenCatalog>) =>
      (chatService ??= new ChatService(
        container.get(DRIZZLE),
        container.get(EVENT_BUS),
        container.get(CHAT_REALTIME_TRANSPORT),
        container.get(ADMIN_USER_DIRECTORY),
      ));

    ctx.provide(CHAT_REALTIME_TRANSPORT, (c) => c.get(REALTIME_TRANSPORT));
    ctx.provide(CHAT_REALTIME_CLIENT_AUTHORIZER, (c) => c.get(REALTIME_CLIENT_AUTHORIZER));
    ctx.provide(CHAT_SYSTEM_WRITER, (c) => getChatService(c));
    ctx.provide(CHAT_BLOCK_WRITER, (c) => getChatService(c));
    ctx.provide(CHAT_ROOM_ACCESS, (c) => ({
      verifyRoomAccess: async (roomId, viewerId) => {
        await getChatService(c).verifyRoomAccess(roomId, viewerId);
      },
    }));

    ctx.routers.add('chat', (c) =>
      createChatRouter({
        chatService: getChatService(c),
        authorizer: c.get(CHAT_REALTIME_CLIENT_AUTHORIZER),
        adminGuard: c.get(ADMIN_GUARD),
        limiter: c.get(RATE_LIMITER),
      }),
    );
  },
});

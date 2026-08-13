import { EVENT_BUS, DRIZZLE, ADMIN_GUARD } from '@openora/core/server';
import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import {
  CHAT_REALTIME_TRANSPORT,
  CHAT_REALTIME_CLIENT_AUTHORIZER,
  RATE_LIMITER,
  CHAT_SYSTEM_WRITER,
  CHAT_BLOCK_WRITER,
  CHAT_ROOM_ACCESS,
  ADMIN_USER_DIRECTORY,
  createToken,
  REALTIME_TRANSPORT,
  REALTIME_CLIENT_AUTHORIZER,
  AUDIT_WRITER,
} from '@openora/core/contracts';
import { ChatService } from './service/chat.service.js';
import { createChatRouter } from './router/index.js';

const CHAT_SERVICE = createToken<ChatService>('_ChatService');

export default {
  id: 'chat',
  dependsOn: ['identity', 'audit'],
  register(ctx) {
    ctx.provide(CHAT_REALTIME_TRANSPORT, (c) => c.get(REALTIME_TRANSPORT));
    ctx.provide(CHAT_REALTIME_CLIENT_AUTHORIZER, (c) => c.get(REALTIME_CLIENT_AUTHORIZER));
    ctx.provide(
      CHAT_SERVICE,
      (c) =>
        new ChatService(
          c.get(DRIZZLE),
          c.get(EVENT_BUS),
          c.get(CHAT_REALTIME_TRANSPORT),
          c.get(ADMIN_USER_DIRECTORY),
          c.get(AUDIT_WRITER),
        ),
    );
    ctx.provide(CHAT_SYSTEM_WRITER, (c) => c.get(CHAT_SERVICE));
    ctx.provide(CHAT_BLOCK_WRITER, (c) => c.get(CHAT_SERVICE));
    ctx.provide(CHAT_ROOM_ACCESS, (c) => ({
      verifyRoomAccess: async (roomId, viewerId) => {
        await c.get(CHAT_SERVICE).verifyRoomAccess(roomId, viewerId);
      },
    }));

    ctx.routers.add('chat', (c) =>
      createChatRouter({
        chatService: c.get(CHAT_SERVICE),
        authorizer: c.get(CHAT_REALTIME_CLIENT_AUTHORIZER),
        adminGuard: c.get(ADMIN_GUARD),
        limiter: c.get(RATE_LIMITER),
      }),
    );
  },
} as const satisfies Plugin<CoreTokenCatalog>;

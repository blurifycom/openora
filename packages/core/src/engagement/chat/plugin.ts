import { EVENT_BUS, DRIZZLE, ADMIN_GUARD } from '@openora/core/server';
import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import {
  CHAT_REALTIME_TRANSPORT,
  CHAT_REALTIME_CLIENT_AUTHORIZER,
  RATE_LIMITER,
  CHAT_SYSTEM_WRITER,
  CHAT_BLOCK_WRITER,
  CHAT_MODERATION,
  CHAT_ROOM_ACCESS,
  ADMIN_USER_DIRECTORY,
  SOCIAL_COMMANDS,
  REALTIME_TRANSPORT,
  REALTIME_CLIENT_AUTHORIZER,
  AUDIT_WRITER,
  IDENTITY_READER,
} from '@openora/core/contracts';
import { ChatService } from './service/chat.service.js';
import { ChatModerationService } from './service/chat-moderation.service.js';
import { ChatRoomMembershipService } from './service/chat-room-membership.service.js';
import { ChatRoomBanService } from './service/chat-room-ban.service.js';
import { ChatRoomMuteService } from './service/chat-room-mute.service.js';
import { createChatRouter } from './router/index.js';

export default {
  id: 'chat',
  dependsOn: ['identity', 'audit'],
  register(ctx) {
    ctx.provide(CHAT_REALTIME_TRANSPORT, (c) => c.get(REALTIME_TRANSPORT));
    ctx.provide(CHAT_REALTIME_CLIENT_AUTHORIZER, (c) => c.get(REALTIME_CLIENT_AUTHORIZER));
    ctx.provide(
      CHAT_MODERATION,
      (c) =>
        new ChatModerationService(
          c.get(DRIZZLE),
          c.get(CHAT_REALTIME_TRANSPORT),
          c.get(AUDIT_WRITER),
        ),
    );
    const createChatService = (
      c: Parameters<typeof ctx.routers.add>[1] extends (c: infer C) => unknown ? C : never,
    ) =>
      new ChatService(
        c.get(DRIZZLE),
        c.get(EVENT_BUS),
        c.get(CHAT_REALTIME_TRANSPORT),
        c.get(ADMIN_USER_DIRECTORY),
        c.get(AUDIT_WRITER),
        c.get(CHAT_MODERATION),
        c.get(IDENTITY_READER),
        c.has(SOCIAL_COMMANDS) ? c.get(SOCIAL_COMMANDS) : undefined,
      );
    const createMembershipService = (
      c: Parameters<typeof ctx.routers.add>[1] extends (c: infer C) => unknown ? C : never,
    ) =>
      new ChatRoomMembershipService(
        c.get(DRIZZLE),
        c.get(EVENT_BUS),
        c.get(AUDIT_WRITER),
        c.get(CHAT_REALTIME_TRANSPORT),
        c.get(IDENTITY_READER),
      );
    ctx.provide(CHAT_SYSTEM_WRITER, createChatService);
    ctx.provide(CHAT_BLOCK_WRITER, createChatService);
    ctx.provide(CHAT_ROOM_ACCESS, (c) => ({
      verifyRoomAccess: async (roomId, viewerId) => {
        await createChatService(c).verifyRoomAccess(roomId, viewerId);
      },
    }));

    ctx.routers.add('chat', (c) => {
      const chatService = createChatService(c);
      return createChatRouter({
        chatService,
        membershipService: createMembershipService(c),
        roomBanService: new ChatRoomBanService(
          c.get(DRIZZLE),
          c.get(EVENT_BUS),
          c.get(AUDIT_WRITER),
          c.get(CHAT_REALTIME_TRANSPORT),
          c.get(IDENTITY_READER),
        ),
        roomMuteService: new ChatRoomMuteService(c.get(DRIZZLE), c.get(AUDIT_WRITER)),
        moderationService: c.get(CHAT_MODERATION),
        authorizer: c.get(CHAT_REALTIME_CLIENT_AUTHORIZER),
        adminGuard: c.get(ADMIN_GUARD),
        limiter: c.get(RATE_LIMITER),
      });
    });
  },
} as const satisfies Plugin<CoreTokenCatalog>;

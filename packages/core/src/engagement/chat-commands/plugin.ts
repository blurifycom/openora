import {
  definePlugin,
  DRIZZLE,
  EVENT_BUS,
  ADMIN_GUARD,
  CORE_TOKEN_CATALOG,
} from '@openora/core/server';
import {
  WALLET_COMMANDS,
  ADMIN_USER_DIRECTORY,
  ADMIN_GAME_REPORTING,
  AUDIT_WRITER,
  CHAT_REALTIME_TRANSPORT,
  CHAT_SYSTEM_WRITER,
  CHAT_BLOCK_WRITER,
  CHAT_ROOM_ACCESS,
  CACHE,
} from '@openora/core/contracts';
import { ChatCommandsService } from './service/chat-commands.service.js';
import { createChatCommandsRouter } from './router/index.js';

export default definePlugin(CORE_TOKEN_CATALOG, {
  id: 'chat-commands',
  dependsOn: ['chat', 'wallet', 'iam', 'audit', 'gaming'],
  register(ctx) {
    ctx.routers.add('chat-commands', (c) => {
      const svc = new ChatCommandsService(
        c.get(DRIZZLE),
        c.get(CHAT_SYSTEM_WRITER),
        c.get(WALLET_COMMANDS),
        c.get(ADMIN_USER_DIRECTORY),
        c.get(AUDIT_WRITER),
        c.get(CHAT_REALTIME_TRANSPORT),
        c.get(EVENT_BUS),
        c.get(CHAT_BLOCK_WRITER),
        c.get(ADMIN_GAME_REPORTING),
        c.get(CHAT_ROOM_ACCESS),
        c.get(CACHE),
      );
      return createChatCommandsRouter(svc, c.get(ADMIN_GUARD));
    });
  },
});

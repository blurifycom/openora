import { definePlugin, DRIZZLE, EVENT_BUS, ADMIN_GUARD } from '@openora/core/server';
import {
  WALLET_COMMANDS,
  ADMIN_USER_DIRECTORY,
  AUDIT_WRITER,
  REALTIME_TRANSPORT,
  CHAT_SYSTEM_WRITER,
  CHAT_BLOCK_WRITER,
} from '@openora/core/contracts';
import { ChatCommandsService } from './service/chat-commands.service.js';
import { createChatCommandsRouter } from './router/index.js';

export default definePlugin({
  id: 'chat-commands',
  dependsOn: ['chat', 'wallet', 'iam', 'audit'],
  register(ctx) {
    ctx.routers.add('chat-commands', (c) => {
      const svc = new ChatCommandsService(
        c.get(DRIZZLE),
        c.get(CHAT_SYSTEM_WRITER),
        c.get(WALLET_COMMANDS),
        c.get(ADMIN_USER_DIRECTORY),
        c.get(AUDIT_WRITER),
        c.get(REALTIME_TRANSPORT),
        c.get(EVENT_BUS),
        c.get(CHAT_BLOCK_WRITER),
      );
      return createChatCommandsRouter(svc, c.get(ADMIN_GUARD));
    });
  },
});

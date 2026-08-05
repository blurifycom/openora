import { DRIZZLE } from '@openora/core/server';
import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import {
  ADMIN_USER_DIRECTORY,
  CHAT_BLOCK_WRITER,
  CHAT_REALTIME_TRANSPORT,
  GIFT_COMMANDS,
  RAIN_COMMANDS,
} from '@openora/core/contracts';
import { ChatCommandsService } from './service/chat-commands.service.js';
import { createChatCommandsRouter } from './router/index.js';

export default {
  id: 'chat-commands',
  dependsOn: ['chat', 'social-transfers'],
  register(ctx) {
    ctx.routers.add('chat-commands', (c) => {
      const svc = new ChatCommandsService(
        c.get(DRIZZLE),
        c.get(ADMIN_USER_DIRECTORY),
        c.get(CHAT_BLOCK_WRITER),
        c.get(GIFT_COMMANDS),
        c.get(RAIN_COMMANDS),
        c.get(CHAT_REALTIME_TRANSPORT),
      );
      return createChatCommandsRouter(svc);
    });
  },
} as const satisfies Plugin<CoreTokenCatalog>;

import { DRIZZLE, ADMIN_GUARD } from '@openora/core/server';
import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import {
  ADMIN_USER_DIRECTORY,
  CHAT_BLOCK_WRITER,
  CHAT_REALTIME_TRANSPORT,
  AUDIT_WRITER,
} from '@openora/core/contracts';
import { ChatCommandsService } from './service/chat-commands.service.js';
import { createChatCommandsRouter } from './router/index.js';

export default {
  id: 'chat-commands',
  dependsOn: ['chat', 'iam', 'audit'],
  register(ctx) {
    ctx.routers.add('chat-commands', (c) => {
      const svc = new ChatCommandsService(
        c.get(DRIZZLE),
        c.get(ADMIN_USER_DIRECTORY),
        c.get(CHAT_BLOCK_WRITER),
        c.get(CHAT_REALTIME_TRANSPORT),
        c.get(AUDIT_WRITER),
      );
      return createChatCommandsRouter(svc, c.get(ADMIN_GUARD));
    });
  },
} as const satisfies Plugin<CoreTokenCatalog>;

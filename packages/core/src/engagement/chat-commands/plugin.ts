import { DRIZZLE, ADMIN_GUARD } from '@openora/core/server';
import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import {
  ADMIN_USER_DIRECTORY,
  CHAT_BLOCK_READER,
  CHAT_CONTEXT_SEND_POLICY,
  CHAT_REALTIME_TRANSPORT,
  CHAT_ROOM_ACCESS,
  CHAT_TRANSFER_CHECK,
  AUDIT_WRITER,
} from '@openora/core/contracts';
import { ChatCommandsService } from './service/chat-commands.service.js';
import { ChatTransferCheckService } from './service/chat-transfer-check.service.js';
import { createChatCommandsRouter } from './router/index.js';

export default {
  id: 'chat-commands',
  dependsOn: ['chat', 'identity', 'audit'],
  register(ctx) {
    ctx.provide(
      CHAT_TRANSFER_CHECK,
      (c) =>
        new ChatTransferCheckService({
          drizzle: c.get(DRIZZLE),
          roomAccess: c.get(CHAT_ROOM_ACCESS),
          contextSendPolicy: c.get(CHAT_CONTEXT_SEND_POLICY),
        }),
    );
    ctx.routers.add('chat-commands', (c) => {
      const svc = new ChatCommandsService(
        c.get(DRIZZLE),
        c.get(ADMIN_USER_DIRECTORY),
        c.get(CHAT_BLOCK_READER),
        c.get(CHAT_REALTIME_TRANSPORT),
        c.get(AUDIT_WRITER),
        c.get(CHAT_ROOM_ACCESS),
      );
      return createChatCommandsRouter(svc, c.get(ADMIN_GUARD));
    });
  },
} as const satisfies Plugin<CoreTokenCatalog>;

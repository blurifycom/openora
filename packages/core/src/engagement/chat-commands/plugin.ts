import { DRIZZLE, ADMIN_GUARD, parseInternalCallers } from '@openora/core/server';
import type { CoreTokenCatalog, Plugin, TypedContainer } from '@openora/core/server';
import {
  ADMIN_USER_DIRECTORY,
  CHAT_BLOCK_READER,
  CHAT_CONTEXT_SEND_POLICY,
  CHAT_REALTIME_TRANSPORT,
  CHAT_ROOM_ACCESS,
  CHAT_TRANSFER_CHECK,
  RATE_LIMITER,
  AUDIT_WRITER,
} from '@openora/core/contracts';
import { ChatCommandsService } from './service/chat-commands.service.js';
import { ChatTransferCheckService } from './service/chat-transfer-check.service.js';
import { createChatCommandsRouter } from './router/index.js';
import { createInternalTransferCheckRouter } from './router/internal-transfer-check.router.js';

export default {
  id: 'chat-commands',
  dependsOn: ['chat', 'identity', 'audit'],
  register(ctx) {
    const localTransferCheck = (c: TypedContainer<CoreTokenCatalog>) =>
      new ChatTransferCheckService({
        roomAccess: c.get(CHAT_ROOM_ACCESS),
        contextSendPolicy: c.get(CHAT_CONTEXT_SEND_POLICY),
      });
    ctx.provide(CHAT_TRANSFER_CHECK, localTransferCheck);
    // The check for a service that does not load chat. It serves this database itself, never the
    // bound check, which such a service rebinds to a client of this very route. Unset
    // CHAT_TRANSFER_CHECK_CALLERS refuses every caller.
    const transferCheckCallerNames = parseInternalCallers(
      process.env['CHAT_TRANSFER_CHECK_CALLERS'],
    );
    ctx.routers.addInternal('chat-commands', (c) =>
      createInternalTransferCheckRouter(
        localTransferCheck(c),
        c.get(DRIZZLE),
        transferCheckCallerNames,
      ),
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
      return createChatCommandsRouter(svc, c.get(ADMIN_GUARD), c.get(RATE_LIMITER));
    });
  },
} as const satisfies Plugin<CoreTokenCatalog>;

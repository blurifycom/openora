import { DRIZZLE, ADMIN_GUARD, EVENT_BUS } from '@openora/core/server';
import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import {
  ADMIN_USER_DIRECTORY,
  CHAT_BLOCK_WRITER,
  CHAT_REALTIME_TRANSPORT,
  CHAT_ROOM_ACCESS,
  CHAT_SYSTEM_WRITER,
  WALLET_COMMANDS,
  CACHE,
  GIFT_COMMANDS,
  RAIN_COMMANDS,
  AUDIT_WRITER,
  createToken,
} from '@openora/core/contracts';
import { ChatCommandsService } from './service/chat-commands.service.js';
import { ChatCommandTransfersService } from './service/chat-command-transfers.service.js';
import { createChatCommandsRouter } from './router/index.js';

const CHAT_COMMAND_TRANSFERS = createToken<ChatCommandTransfersService>('_ChatCommandTransfers');

export default {
  id: 'chat-commands',
  dependsOn: ['chat', 'wallet', 'iam', 'audit'],
  register(ctx) {
    ctx.provide(
      CHAT_COMMAND_TRANSFERS,
      (c) =>
        new ChatCommandTransfersService(
          c.get(DRIZZLE),
          c.get(CHAT_SYSTEM_WRITER),
          c.get(WALLET_COMMANDS),
          c.get(ADMIN_USER_DIRECTORY),
          c.get(AUDIT_WRITER),
          c.get(CHAT_REALTIME_TRANSPORT),
          c.get(EVENT_BUS),
          c.get(CHAT_ROOM_ACCESS),
          c.get(CHAT_BLOCK_WRITER),
          c.get(CACHE),
        ),
    );
    ctx.provide(GIFT_COMMANDS, (c) => c.get(CHAT_COMMAND_TRANSFERS));
    ctx.provide(RAIN_COMMANDS, (c) => c.get(CHAT_COMMAND_TRANSFERS));
    ctx.routers.add('chat-commands', (c) => {
      const svc = new ChatCommandsService(
        c.get(DRIZZLE),
        c.get(ADMIN_USER_DIRECTORY),
        c.get(CHAT_BLOCK_WRITER),
        c.get(GIFT_COMMANDS),
        c.get(RAIN_COMMANDS),
        c.get(CHAT_REALTIME_TRANSPORT),
        c.get(AUDIT_WRITER),
      );
      return createChatCommandsRouter(svc, c.get(CHAT_COMMAND_TRANSFERS), c.get(ADMIN_GUARD));
    });
  },
} as const satisfies Plugin<CoreTokenCatalog>;

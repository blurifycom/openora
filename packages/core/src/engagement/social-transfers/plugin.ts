import { EVENT_BUS, DRIZZLE } from '@openora/core/server';
import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import {
  CHAT_SYSTEM_WRITER,
  CHAT_BLOCK_WRITER,
  WALLET_COMMANDS,
  ADMIN_USER_DIRECTORY,
  AUDIT_WRITER,
  CHAT_REALTIME_TRANSPORT,
  CHAT_ROOM_ACCESS,
  CACHE,
  GIFT_COMMANDS,
  RAIN_COMMANDS,
  createToken,
} from '@openora/core/contracts';
import { SocialTransfersService } from './service/social-transfers.service.js';
import { createSocialTransfersRouter } from './router/index.js';

const SOCIAL_TRANSFERS_SERVICE = createToken<SocialTransfersService>('_SocialTransfersService');

// Owns donate/gift/rain money movement for the chat command surface. Binds
// GIFT_COMMANDS and RAIN_COMMANDS so chat-commands can post/claim gifts and
// send rain without reimplementing the wallet/idempotency/limit logic - see
// this module's AGENTS.md. This module still depends on `chat` for
// CHAT_SYSTEM_WRITER/CHAT_ROOM_ACCESS/CHAT_REALTIME_TRANSPORT.publish (all
// threaded through its own db.transaction, so it must own them directly) -
// but it never queries chat's presence tracking: chat-commands resolves
// online recipients and passes them into RAIN_COMMANDS.sendRain.
export default {
  id: 'social-transfers',
  dependsOn: ['chat', 'wallet', 'iam', 'audit'],
  register(ctx) {
    ctx.provide(
      SOCIAL_TRANSFERS_SERVICE,
      (c) =>
        new SocialTransfersService(
          c.get(DRIZZLE),
          c.get(CHAT_SYSTEM_WRITER),
          c.get(CHAT_BLOCK_WRITER),
          c.get(WALLET_COMMANDS),
          c.get(ADMIN_USER_DIRECTORY),
          c.get(AUDIT_WRITER),
          c.get(CHAT_REALTIME_TRANSPORT),
          c.get(EVENT_BUS),
          c.get(CHAT_ROOM_ACCESS),
          c.get(CACHE),
        ),
    );
    ctx.provide(GIFT_COMMANDS, (c) => c.get(SOCIAL_TRANSFERS_SERVICE));
    ctx.provide(RAIN_COMMANDS, (c) => c.get(SOCIAL_TRANSFERS_SERVICE));

    ctx.routers.add('socialTransfers', (c) =>
      createSocialTransfersRouter(c.get(SOCIAL_TRANSFERS_SERVICE)),
    );
  },
} as const satisfies Plugin<CoreTokenCatalog>;

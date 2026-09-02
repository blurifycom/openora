import * as z from 'zod';
import { EVENT_BUS, DRIZZLE, ADMIN_GUARD, createLogger } from '@openora/core/server';
import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import {
  JOB_QUEUE,
  queue,
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
  PLATFORM_CONFIG,
} from '@openora/core/contracts';
import { ChatService } from './service/chat.service.js';
import { ChatModerationService } from './service/chat-moderation.service.js';
import { ChatRoomMembershipService } from './service/chat-room-membership.service.js';
import { ChatRoomBanService } from './service/chat-room-ban.service.js';
import { ChatRoomMuteService } from './service/chat-room-mute.service.js';
import { ChatModerationExpiryService } from './service/chat-moderation-expiry.service.js';
import { createChatRouter } from './router/index.js';

const CHAT_MODERATION_EXPIRY_QUEUE = queue('chat-moderation-expiry');

// Quarter-hourly, offset off the :00/:15/:30/:45 tick the wallet custody sweep owns, so
// the in-process driver never runs this alongside a money path. The cadence sets
// audit-trail latency only - a lapsed mute stops being enforced at its own expiresAt,
// with or without this job - and the entry is dated from the row, so a late or missed run
// still records the right instant; the offset therefore costs nothing.
const CHAT_MODERATION_EXPIRY_CRON = '7,22,37,52 * * * *';

// The cron tick carries no state - the job's whole input is "what has lapsed by now".
const EmptyJobPayloadSchema = z.object({});

export default {
  id: 'chat',
  dependsOn: ['identity', 'audit'],
  register(ctx) {
    const logger = createLogger('chat');
    let expiryRef: ChatModerationExpiryService | undefined;
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
      new ChatService({
        drizzle: c.get(DRIZZLE),
        events: c.get(EVENT_BUS),
        transport: c.get(CHAT_REALTIME_TRANSPORT),
        directory: c.get(ADMIN_USER_DIRECTORY),
        audit: c.get(AUDIT_WRITER),
        moderation: c.get(CHAT_MODERATION),
        identityReader: c.get(IDENTITY_READER),
        allowedAttachmentHosts: c.has(PLATFORM_CONFIG)
          ? c.get(PLATFORM_CONFIG).chat.allowedAttachmentHosts
          : [],
        socialCommands: c.has(SOCIAL_COMMANDS) ? c.get(SOCIAL_COMMANDS) : undefined,
      });
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

    ctx.jobs.worker({
      queue: CHAT_MODERATION_EXPIRY_QUEUE,
      schema: EmptyJobPayloadSchema,
      handler: async () => {
        if (!expiryRef) {
          return;
        }
        const { mutes, bans } = await expiryRef.sweep();
        if (mutes > 0 || bans > 0) {
          logger.info({ mutes, bans }, 'chat moderation expiry recorded');
        }
      },
    });

    ctx.routers.add('chat', (c) => {
      const chatService = createChatService(c);
      expiryRef = new ChatModerationExpiryService(c.get(DRIZZLE), c.get(AUDIT_WRITER));
      const expiryCron =
        (c.has(PLATFORM_CONFIG) ? c.get(PLATFORM_CONFIG).chat.moderationExpiry?.cron : undefined) ??
        CHAT_MODERATION_EXPIRY_CRON;
      // Idempotent registration (keyed by scheduleId). JOB_QUEUE binds to BullMQ whenever
      // REDIS_URL is set, which every real deployment has, so the schedule is durable
      // there; the in-process default still ticks for `pnpm dev`.
      void c
        .get(JOB_QUEUE)
        .schedule(
          CHAT_MODERATION_EXPIRY_QUEUE,
          'chat-moderation-expiry.cron',
          {},
          { cron: expiryCron },
        )
        .catch((err: unknown) => logger.error({ err }, 'chat-moderation-expiry schedule failed'));
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

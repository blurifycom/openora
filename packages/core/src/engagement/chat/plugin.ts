import * as z from 'zod';
import { EVENT_BUS, DRIZZLE, ADMIN_GUARD, createLogger } from '@openora/core/server';
import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import {
  JOB_QUEUE,
  domainEventSchemas,
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
import { ChatRoomPurgeService } from './service/chat-room-purge.service.js';
import { createChatRouter } from './router/index.js';

const CHAT_ROOM_PURGE_QUEUE = queue('chat-room-purge');

// Daily at 03:15. The deadline the job checks has day granularity, so a finer tick buys
// nothing and one missed run only deletes a day late.
const CHAT_ROOM_PURGE_CRON = '15 3 * * *';

// The cron tick carries no state - the job's whole input is "what is due right now".
const EmptyJobPayloadSchema = z.object({});

export default {
  id: 'chat',
  dependsOn: ['identity', 'audit'],
  register(ctx) {
    const logger = createLogger('chat');
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

    // Subscriptions and job workers wire before router factories run (create-app boot
    // order), so these are null at registration and set from the factory below, before
    // any real event or tick can arrive - the same shape wallet and notifications use.
    let membershipRef: ChatRoomMembershipService | null = null;
    let purgeRef: ChatRoomPurgeService | null = null;

    // Both triggers route into one handler. An admin closing the player and the auth user
    // being deactivated are two views of the same fact, and either can happen without the
    // other; the handler is idempotent, so both firing for one person is a no-op the
    // second time. Deactivation is reversible and this is not - a reactivated player does
    // not get their room back.
    const onAccountClosed = (userId: string) => {
      if (!membershipRef) {
        return;
      }
      membershipRef
        .handleAccountClosed({ userId, closedAt: new Date() })
        .catch((err: unknown) =>
          logger.error({ err, userId }, 'chat account-closed handling failed'),
        );
    };

    ctx.events.on('player.account.closed', (payload) => {
      const parsed = domainEventSchemas['player.account.closed'].safeParse(payload);
      if (parsed.success) {
        onAccountClosed(parsed.data.userId);
      }
    });

    ctx.events.on('identity.user.deactivated', (payload) => {
      const parsed = domainEventSchemas['identity.user.deactivated'].safeParse(payload);
      if (parsed.success) {
        onAccountClosed(parsed.data.userId);
      }
    });

    ctx.jobs.worker({
      queue: CHAT_ROOM_PURGE_QUEUE,
      schema: EmptyJobPayloadSchema,
      handler: async () => {
        if (!purgeRef) {
          throw new Error('chat room purge: service not constructed yet');
        }
        await purgeRef.runCycle();
      },
    });

    ctx.routers.add('chat', (c) => {
      const chatService = createChatService(c);
      const membershipService = createMembershipService(c);
      membershipRef = membershipService;
      purgeRef = new ChatRoomPurgeService(
        c.get(DRIZZLE),
        c.get(EVENT_BUS),
        c.get(CHAT_REALTIME_TRANSPORT),
      );
      // Idempotent registration (keyed by scheduleId). JOB_QUEUE binds to BullMQ whenever
      // REDIS_URL is set, which every real deployment has, so the schedule is durable
      // there; the in-process default still ticks for `pnpm dev`.
      void c
        .get(JOB_QUEUE)
        .schedule(CHAT_ROOM_PURGE_QUEUE, 'chat-room-purge.cron', {}, { cron: CHAT_ROOM_PURGE_CRON })
        .catch((err: unknown) => logger.error({ err }, 'chat-room-purge schedule failed'));
      return createChatRouter({
        chatService,
        membershipService,
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

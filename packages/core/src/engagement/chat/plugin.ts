import * as z from 'zod';
import { EVENT_BUS, DRIZZLE, ADMIN_GUARD, createLogger } from '@openora/core/server';
import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import type { JobQueueAdapter } from '@openora/core/contracts';
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
  CHAT_MODERATION_EXPIRY_DEFAULT_CRON,
  UuidSchema,
} from '@openora/core/contracts';
import { ChatService } from './service/chat.service.js';
import { ChatModerationService } from './service/chat-moderation.service.js';
import { ChatRoomMembershipService } from './service/chat-room-membership.service.js';
import { ChatRoomBanService } from './service/chat-room-ban.service.js';
import { ChatRoomMuteService } from './service/chat-room-mute.service.js';
import { ChatModerationExpiryService } from './service/chat-moderation-expiry.service.js';
import { ChatRoomPurgeService } from './service/chat-room-purge.service.js';
import { createChatRouter } from './router/index.js';

const CHAT_MODERATION_EXPIRY_QUEUE = queue('chat-moderation-expiry');
const CHAT_ROOM_PURGE_SCAN_QUEUE = queue('chat-room-purge-scan');
const CHAT_ROOM_PURGE_QUEUE = queue('chat-room-purge');
const CHAT_ACCOUNT_CLOSED_QUEUE = queue('chat-account-closed');
const CHAT_ACCOUNT_REOPENED_QUEUE = queue('chat-account-reopened');

const CHAT_ROOM_PURGE_CRON = '15 3 * * *';
const CHAT_ROOM_PURGE_TIMEZONE = 'UTC';

const CHAT_ROOM_PURGE_BATCH = 500;

const RETRY = { attempts: 5, backoff: { type: 'exponential', delayMs: 1000 } } as const;

const accountJobKey = (prefix: string, userId: string, at: Date) =>
  `${prefix}:${userId}:${at.toISOString().slice(0, 10)}`;

// The cron tick carries no state - the job's whole input is "what has lapsed by now".
const EmptyJobPayloadSchema = z.object({});
const RoomPurgeJobSchema = z.object({ roomId: UuidSchema });
const AccountClosedJobSchema = z.object({ userId: UuidSchema, closedAt: z.iso.datetime() });
const AccountReopenedJobSchema = z.object({ userId: UuidSchema });

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
          // Workers started without building routers: the sweep is wired to the router
          // factory, so it has nothing to run. Say so rather than no-op in silence.
          logger.warn('chat-moderation-expiry sweep skipped - service not constructed');
          return;
        }
        const { mutes, bans } = await expiryRef.sweep();
        if (mutes > 0 || bans > 0) {
          logger.info({ mutes, bans }, 'chat moderation expiry recorded');
        }
      },
    });

    let membershipRef: ChatRoomMembershipService | null = null;
    let purgeRef: ChatRoomPurgeService | null = null;
    let jobQueueRef: JobQueueAdapter | null = null;

    const onAccountClosed = (userId: string) => {
      if (!jobQueueRef) {
        logger.error({ userId }, 'chat account-closed dropped: job queue not bound yet');
        return;
      }
      const closedAt = new Date();
      jobQueueRef
        .enqueue(
          CHAT_ACCOUNT_CLOSED_QUEUE,
          { userId, closedAt: closedAt.toISOString() },
          { idempotencyKey: accountJobKey('chat-account-closed', userId, closedAt), ...RETRY },
        )
        .catch((err: unknown) =>
          logger.error({ err, userId }, 'chat account-closed enqueue failed'),
        );
    };

    const onAccountReopened = (userId: string) => {
      if (!jobQueueRef) {
        logger.error({ userId }, 'chat account-reopened dropped: job queue not bound yet');
        return;
      }
      jobQueueRef
        .enqueue(
          CHAT_ACCOUNT_REOPENED_QUEUE,
          { userId },
          {
            idempotencyKey: accountJobKey('chat-account-reopened', userId, new Date()),
            ...RETRY,
          },
        )
        .catch((err: unknown) =>
          logger.error({ err, userId }, 'chat account-reopened enqueue failed'),
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

    ctx.events.on('player.account.reopened', (payload) => {
      const parsed = domainEventSchemas['player.account.reopened'].safeParse(payload);
      if (parsed.success) {
        onAccountReopened(parsed.data.userId);
      }
    });

    ctx.events.on('identity.user.reactivated', (payload) => {
      const parsed = domainEventSchemas['identity.user.reactivated'].safeParse(payload);
      if (parsed.success) {
        onAccountReopened(parsed.data.userId);
      }
    });

    ctx.jobs.worker({
      queue: CHAT_ACCOUNT_CLOSED_QUEUE,
      schema: AccountClosedJobSchema,
      handler: async ({ payload }) => {
        if (!membershipRef) {
          throw new Error('chat account-closed: service not constructed yet');
        }
        await membershipRef.handleAccountClosed({
          userId: payload.userId,
          closedAt: new Date(payload.closedAt),
        });
      },
      onDeadLetter: (jobCtx, error) => {
        logger.error(
          { err: error, userId: jobCtx.payload.userId, jobId: jobCtx.id },
          'chat account-closed handling exhausted retries',
        );
      },
    });

    ctx.jobs.worker({
      queue: CHAT_ACCOUNT_REOPENED_QUEUE,
      schema: AccountReopenedJobSchema,
      handler: async ({ payload }) => {
        if (!membershipRef) {
          throw new Error('chat account-reopened: service not constructed yet');
        }
        await membershipRef.handleAccountReopened({ userId: payload.userId });
      },
      onDeadLetter: (jobCtx, error) => {
        logger.error(
          { err: error, userId: jobCtx.payload.userId, jobId: jobCtx.id },
          'chat account-reopened handling exhausted retries',
        );
      },
    });

    ctx.jobs.worker({
      queue: CHAT_ROOM_PURGE_SCAN_QUEUE,
      schema: EmptyJobPayloadSchema,
      handler: async () => {
        if (!purgeRef || !jobQueueRef) {
          throw new Error('chat room purge: service not constructed yet');
        }
        const queueRef = jobQueueRef;
        const due = await purgeRef.listDueRooms(CHAT_ROOM_PURGE_BATCH);
        const tick = new Date().toISOString().slice(0, 10);
        for (const roomId of due) {
          await queueRef
            .enqueue(
              CHAT_ROOM_PURGE_QUEUE,
              { roomId },
              { idempotencyKey: `chat-room-purge:${roomId}:${tick}`, ...RETRY },
            )
            .catch((err: unknown) =>
              logger.error({ err, roomId }, 'chat-room-purge enqueue failed'),
            );
        }
        logger.info({ count: due.length }, 'chat room purge dispatched');
      },
      onDeadLetter: (jobCtx, error) => {
        logger.error({ err: error, jobId: jobCtx.id }, 'chat room purge scan failed');
      },
    });

    ctx.jobs.worker({
      queue: CHAT_ROOM_PURGE_QUEUE,
      schema: RoomPurgeJobSchema,
      handler: async ({ payload }) => {
        if (!purgeRef) {
          throw new Error('chat room purge: service not constructed yet');
        }
        await purgeRef.purgeRoom(payload.roomId);
      },
      onDeadLetter: (jobCtx, error) => {
        logger.error(
          { err: error, roomId: jobCtx.payload.roomId, jobId: jobCtx.id },
          'chat room purge exhausted retries',
        );
      },
    });

    ctx.routers.add('chat', (c) => {
      const chatService = createChatService(c);
      expiryRef = new ChatModerationExpiryService(c.get(DRIZZLE), c.get(AUDIT_WRITER));
      const expiryCron =
        (c.has(PLATFORM_CONFIG) ? c.get(PLATFORM_CONFIG).chat.moderationExpiry?.cron : undefined) ??
        CHAT_MODERATION_EXPIRY_DEFAULT_CRON;
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
      const membershipService = createMembershipService(c);
      membershipRef = membershipService;
      purgeRef = new ChatRoomPurgeService(
        c.get(DRIZZLE),
        c.get(EVENT_BUS),
        c.get(CHAT_REALTIME_TRANSPORT),
        c.get(AUDIT_WRITER),
      );
      jobQueueRef = c.get(JOB_QUEUE);
      void jobQueueRef
        .schedule(
          CHAT_ROOM_PURGE_SCAN_QUEUE,
          'chat-room-purge.cron',
          {},
          { cron: CHAT_ROOM_PURGE_CRON, timezone: CHAT_ROOM_PURGE_TIMEZONE },
        )
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

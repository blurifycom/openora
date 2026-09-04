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
  UuidSchema,
} from '@openora/core/contracts';
import { ChatService } from './service/chat.service.js';
import { ChatModerationService } from './service/chat-moderation.service.js';
import { ChatRoomMembershipService } from './service/chat-room-membership.service.js';
import { ChatRoomBanService } from './service/chat-room-ban.service.js';
import { ChatRoomMuteService } from './service/chat-room-mute.service.js';
import { ChatRoomPurgeService } from './service/chat-room-purge.service.js';
import { createChatRouter } from './router/index.js';

// The cron tick only finds work and hands it out; one job per room does the deleting, so a
// room that fails to purge retries on its own and never blocks the rooms behind it.
const CHAT_ROOM_PURGE_SCAN_QUEUE = queue('chat-room-purge-scan');
const CHAT_ROOM_PURGE_QUEUE = queue('chat-room-purge');
const CHAT_ACCOUNT_CLOSED_QUEUE = queue('chat-account-closed');
const CHAT_ACCOUNT_REOPENED_QUEUE = queue('chat-account-reopened');

// Daily at 03:15 UTC. The deadline the job checks has day granularity, so a finer tick buys
// nothing and one missed run only deletes a day late. The timezone is pinned because the
// driver otherwise follows process-local time, and two replicas in different zones would
// disagree on when "daily" is.
const CHAT_ROOM_PURGE_CRON = '15 3 * * *';
const CHAT_ROOM_PURGE_TIMEZONE = 'UTC';

// One tick's fan-out. A deadline that has already passed does not get worse by being purged
// on tomorrow's tick, so a backlog after downtime is drained across ticks rather than in one.
const CHAT_ROOM_PURGE_BATCH = 500;

// Retry policy shared by both workers: the work is a handful of statements against the
// primary, so what it survives is a restart or a blip, not a permanently broken room.
const RETRY = { attempts: 5, backoff: { type: 'exponential', delayMs: 1000 } } as const;

// Per user AND per day, for the same reason the purge key is per room and per tick: the
// driver retains completed jobs for 24h and failed ones for 7 days, and an `enqueue` whose
// id is already in either set is a silent no-op. A user-only key would make a second
// closure - after a reactivation, or after the first job dead-lettered - vanish without an
// error. Day granularity still collapses the two triggers for one closure, which fire
// within seconds of each other.
const accountJobKey = (prefix: string, userId: string, at: Date) =>
  `${prefix}:${userId}:${at.toISOString().slice(0, 10)}`;

// The cron tick carries no state - the job's whole input is "what is due right now".
const EmptyJobPayloadSchema = z.object({});
const RoomPurgeJobSchema = z.object({ roomId: UuidSchema });
const AccountClosedJobSchema = z.object({ userId: UuidSchema, closedAt: z.iso.datetime() });
const AccountReopenedJobSchema = z.object({ userId: UuidSchema });

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
    let jobQueueRef: JobQueueAdapter | null = null;

    // Both triggers route into one handler, on the queue rather than in-process. The event
    // itself is a best-effort emit and this handler touches several rooms, so running it
    // inline meant a throw on room 3 of 10 stranded the rest with nothing to retry it - the
    // exact failure this module exists to prevent. An admin closing the player and the auth
    // user being deactivated are two views of the same fact and either can happen without
    // the other, so both collapse onto one job per user: the key dedupes them, and the
    // handler is idempotent for the case where it does not. Both triggers are reversible, so
    // both inverses are subscribed below: an account that comes back stops being rendered as
    // a deleted one, and a countdown its closure started is cancelled rather than left to
    // hard-delete the room 30 days after an action the operator undid. What does not come
    // back is a room a moderator inherited - that transfer stands.
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

    // The mirror image: an account that came back has to stop being rendered as a deleted
    // one, and any room its closure put on the deletion countdown has to come off it. On the
    // queue for the same reason the closure is - the emit behind it is best-effort, and the
    // work it undoes is a scheduled hard delete.
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
        // The event's timestamp, not the attempt's: it is what ties the writes to this
        // closure, so a retry must re-derive against the same instant the first try used.
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
        // The key is per room AND per tick. Per room so two replicas ticking together
        // enqueue one job, per tick so a room whose job exhausted its retries is picked up
        // again tomorrow instead of colliding with the dead job id still in the driver's
        // retained set.
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
      // `schedule` never passes `attempts`, so the tick itself runs once and a failed scan
      // is otherwise silent until tomorrow's. The rooms are not lost - the next tick reads
      // the same deadlines - but the miss has to be visible.
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
      const membershipService = createMembershipService(c);
      membershipRef = membershipService;
      purgeRef = new ChatRoomPurgeService(
        c.get(DRIZZLE),
        c.get(EVENT_BUS),
        c.get(CHAT_REALTIME_TRANSPORT),
        c.get(AUDIT_WRITER),
      );
      jobQueueRef = c.get(JOB_QUEUE);
      // Idempotent registration (keyed by scheduleId).
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

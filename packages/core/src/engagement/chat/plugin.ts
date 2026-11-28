import { randomUUID } from 'node:crypto';
import * as z from 'zod';
import {
  EVENT_BUS,
  DRIZZLE,
  ADMIN_GUARD,
  createInternalClient,
  createLogger,
  REMOTE_SESSION_RESOLVER,
  AuthContextSchema,
  mapErrors,
  parseInternalCallers,
  parseServiceManifest,
} from '@openora/core/server';
import type {
  CoreTokenCatalog,
  DrizzleService,
  DrizzleTx,
  InternalClient,
  Plugin,
} from '@openora/core/server';
import type { ChatContextRooms, EventEnvelope, JobQueueAdapter } from '@openora/core/contracts';
import {
  JOB_QUEUE,
  domainEventSchemas,
  queue,
  CHAT_REALTIME_TRANSPORT,
  CHAT_REALTIME_CLIENT_AUTHORIZER,
  RATE_LIMITER,
  ADMIN_SECURITY_POLICY,
  ADMIN_PERMISSION_RESOLVER,
  CHAT_SYSTEM_WRITER,
  CHAT_BLOCK_READER,
  CHAT_BLOCK_WRITER,
  CHAT_CONTEXT_ROOMS,
  CHAT_CONTEXT_ROOM_COMMANDS,
  CHAT_CONTEXT_SEND_POLICY,
  CHAT_MODERATION,
  CHAT_ROOM_ACCESS,
  ACCOUNT_READER,
  SOCIAL_COMMANDS,
  REALTIME_TRANSPORT,
  REALTIME_CLIENT_AUTHORIZER,
  AUDIT_WRITER,
  PLATFORM_CONFIG,
  PLAY_ELIGIBILITY,
  playerIdsOf,
  CHAT_MODERATION_EXPIRY_DEFAULT_CRON,
  UuidSchema,
} from '@openora/core/contracts';
import { ChatService, ChatRoomNotMemberError } from './service/chat.service.js';
import {
  ChatModerationService,
  ChatPlayerBannedError,
  ChatRoomNotFoundError,
} from './service/chat-moderation.service.js';
import { ChatRoomMembershipService } from './service/chat-room-membership.service.js';
import { ChatContextRoomService } from './service/chat-context-room.service.js';
import { ChatRoomInviteService } from './service/chat-room-invite.service.js';
import { ChatRoomBanService } from './service/chat-room-ban.service.js';
import { ChatRoomMuteService } from './service/chat-room-mute.service.js';
import { ChatRoomRestrictionService } from './service/chat-room-restriction.service.js';
import { ChatModerationExpiryService } from './service/chat-moderation-expiry.service.js';
import { ChatRoomPurgeService } from './service/chat-room-purge.service.js';
import { ChatSystemCardService } from './service/chat-system-card.service.js';
import { applyContextRoomCommand } from './service/chat-context-room-command.service.js';
import { RemoteAccountReader } from './service/remote-account-reader.service.js';
import { RemoteAdminPermissionResolver } from './service/remote-admin-permission-resolver.service.js';
import { RemoteAdminSecurityPolicy } from './service/remote-admin-security.service.js';
import { RemoteSessionResolver } from './service/remote-session-resolver.service.js';
import { createChatRouter } from './router/index.js';
import { createInternalBlocksRouter } from './router/internal-blocks.router.js';

const CHAT_MODERATION_EXPIRY_QUEUE = queue('chat-moderation-expiry');
const CHAT_ROOM_PURGE_SCAN_QUEUE = queue('chat-room-purge-scan');
const CHAT_ROOM_PURGE_QUEUE = queue('chat-room-purge');
const CHAT_ACCOUNT_CLOSED_QUEUE = queue('chat-account-closed');
const CHAT_ACCOUNT_REOPENED_QUEUE = queue('chat-account-reopened');
const CHAT_ROOM_INVITE_EXPIRY_QUEUE = queue('chat-room-invite-expiry');

const CHAT_ROOM_PURGE_CRON = '15 3 * * *';
const CHAT_ROOM_PURGE_TIMEZONE = 'UTC';

const CHAT_ROOM_PURGE_BATCH = 500;

const CHAT_ROOM_INVITE_EXPIRY_CRON = '0 * * * *';

const RETRY = { attempts: 5, backoff: { type: 'exponential', delayMs: 1000 } } as const;

const accountJobKey = (prefix: string, userId: string, envelope?: EventEnvelope) =>
  `${prefix}:${userId}:${envelope?.eventId ?? randomUUID()}`;

const EmptyJobPayloadSchema = z.object({});
const RoomPurgeJobSchema = z.object({ roomId: UuidSchema });
const AccountClosedJobSchema = z.object({ userId: UuidSchema, closedAt: z.iso.datetime() });
const AccountReopenedJobSchema = z.object({ userId: UuidSchema });

const logger = createLogger('chat');

const IDENTITY_CALL_TIMEOUT_MS = 500;

function identityClient(): InternalClient | null {
  const url = process.env['IDENTITY_SERVICE_URL'];
  if (!url) {
    return null;
  }
  const manifest = parseServiceManifest(process.env['SERVICE_MANIFEST']);
  if (!manifest || manifest.some((entry) => entry.id === 'identity' && !entry.noRoutes)) {
    throw new Error(
      'IDENTITY_SERVICE_URL is set, but this process serves the identity module itself. ' +
        'Unset it, or run chat with a SERVICE_MANIFEST that names identity:no-routes.',
    );
  }
  if (
    process.env['NODE_ENV'] === 'production' &&
    new URL(url).protocol !== 'https:' &&
    process.env['IDENTITY_SERVICE_ALLOW_HTTP'] !== 'true'
  ) {
    throw new Error(
      'IDENTITY_SERVICE_URL is not https in production, so account reads and the session ' +
        'cookies chat forwards would cross the network in clear text. Use https, or set ' +
        'IDENTITY_SERVICE_ALLOW_HTTP=true where a service mesh inside the private network ' +
        'encrypts the hop.',
    );
  }
  return createInternalClient({
    baseUrl: url,
    serviceName: process.env['SERVICE_NAME'] || 'monolith',
    audience: process.env['IDENTITY_SERVICE_NAME'] || 'monolith',
    secrets: process.env['INTERNAL_API_SECRETS'],
    timeoutMs: IDENTITY_CALL_TIMEOUT_MS,
  });
}

const SESSION_PURGE_CHANNEL = 'chat:session-purge';
const SessionPurgeSchema = AuthContextSchema.pick({ userId: true });
type SessionPurge = z.infer<typeof SessionPurgeSchema>;
const SESSION_ENDING_EVENTS = [
  'identity.session.revoked',
  'identity.sessions.revoked_all',
  'identity.user.deactivated',
] as const;

export default {
  id: 'chat',
  dependsOn: ['identity', 'audit', 'iam'],
  register(ctx) {
    if (process.env['CHAT_SERVICE_URL']) {
      throw new Error(
        'CHAT_SERVICE_URL is set, but this process loads the chat module itself, so the chat ' +
          'ports would be bound twice. Unset it here, or leave chat out of this process and load ' +
          'chat-remote instead.',
      );
    }
    const identity = identityClient();
    if (identity) {
      const remoteAccounts = new RemoteAccountReader(identity);
      ctx.provide(ACCOUNT_READER, () => remoteAccounts);
      ctx.provide(ADMIN_SECURITY_POLICY, () => new RemoteAdminSecurityPolicy(identity));
      ctx.provide(ADMIN_PERMISSION_RESOLVER, () => new RemoteAdminPermissionResolver(identity));
      const remoteSessions = new RemoteSessionResolver(identity);
      let announcePurge: ((userId: string) => void | Promise<void>) | undefined;
      ctx.provide(REMOTE_SESSION_RESOLVER, (c) => {
        const transport = c.get(REALTIME_TRANSPORT);
        c.onDispose(
          transport.subscribe<unknown>(SESSION_PURGE_CHANNEL, (payload) => {
            const purge = SessionPurgeSchema.safeParse(payload);
            if (purge.success) {
              remoteSessions.purgeUser(purge.data.userId);
            } else {
              logger.warn({ issues: purge.error.issues }, 'ignored a malformed session purge');
            }
          }),
        );
        announcePurge = (userId) =>
          transport.publish<SessionPurge>(SESSION_PURGE_CHANNEL, { userId });
        return remoteSessions;
      });
      for (const topic of SESSION_ENDING_EVENTS) {
        ctx.events.on(topic, async (payload) => {
          const parsed = domainEventSchemas[topic].safeParse(payload);
          if (!parsed.success) {
            return;
          }
          if (!announcePurge) {
            throw new Error('chat session purge: resolver not constructed yet');
          }
          await announcePurge(parsed.data.userId);
        });
      }
    }
    let expiryRef: ChatModerationExpiryService | undefined;
    let inviteRef: ChatRoomInviteService | undefined;
    ctx.provide(CHAT_REALTIME_TRANSPORT, (c) => c.get(REALTIME_TRANSPORT));
    ctx.provide(CHAT_REALTIME_CLIENT_AUTHORIZER, (c) => c.get(REALTIME_CLIENT_AUTHORIZER));
    ctx.provide(CHAT_CONTEXT_SEND_POLICY, () => ({ check: async () => ({ allowed: true }) }));
    ctx.provide(
      CHAT_MODERATION,
      (c) =>
        new ChatModerationService(
          c.get(DRIZZLE),
          c.get(CHAT_REALTIME_TRANSPORT),
          c.get(AUDIT_WRITER),
          c.get(EVENT_BUS),
        ),
    );
    const createChatService = (
      c: Parameters<typeof ctx.routers.add>[1] extends (c: infer C) => unknown ? C : never,
    ) =>
      new ChatService({
        drizzle: c.get(DRIZZLE),
        events: c.get(EVENT_BUS),
        transport: c.get(CHAT_REALTIME_TRANSPORT),
        audit: c.get(AUDIT_WRITER),
        moderation: c.get(CHAT_MODERATION),
        accounts: c.get(ACCOUNT_READER),
        allowedAttachmentHosts: c.has(PLATFORM_CONFIG)
          ? c.get(PLATFORM_CONFIG).chat.allowedAttachmentHosts
          : [],
        socialCommands: c.has(SOCIAL_COMMANDS) ? c.get(SOCIAL_COMMANDS) : undefined,
        contextSendPolicy: c.get(CHAT_CONTEXT_SEND_POLICY),
      });
    const createMembershipService = (
      c: Parameters<typeof ctx.routers.add>[1] extends (c: infer C) => unknown ? C : never,
    ) =>
      new ChatRoomMembershipService(
        c.get(DRIZZLE),
        c.get(EVENT_BUS),
        c.get(AUDIT_WRITER),
        c.get(CHAT_REALTIME_TRANSPORT),
        c.get(ACCOUNT_READER),
      );
    ctx.provide(CHAT_SYSTEM_WRITER, createChatService);
    ctx.provide(CHAT_BLOCK_WRITER, createChatService);
    ctx.provide(CHAT_BLOCK_READER, createChatService);
    ctx.provide(
      CHAT_CONTEXT_ROOMS,
      (c) =>
        new ChatContextRoomService({
          drizzle: c.get(DRIZZLE),
          audit: c.get(AUDIT_WRITER),
          events: c.get(EVENT_BUS),
          accounts: c.get(ACCOUNT_READER),
          transport: c.get(CHAT_REALTIME_TRANSPORT),
          systemWriter: c.get(CHAT_SYSTEM_WRITER),
        }),
    );
    ctx.provide(CHAT_CONTEXT_ROOM_COMMANDS, (c) => c.get(CHAT_CONTEXT_ROOMS));
    const blockReaderCallerNames = parseInternalCallers(process.env['CHAT_BLOCK_READER_CALLERS']);
    ctx.routers.addInternal('chat', (c) =>
      createInternalBlocksRouter(createChatService(c), blockReaderCallerNames),
    );
    ctx.provide(CHAT_ROOM_ACCESS, (c) => ({
      verifyRoomAccess: async (roomId, viewerId, tx) => {
        await mapErrors(
          {
            NOT_FOUND: ChatRoomNotFoundError,
            FORBIDDEN: [ChatRoomNotMemberError, ChatPlayerBannedError],
          },
          () =>
            createChatService(c).verifyRoomAccess(roomId, viewerId, tx as DrizzleTx | undefined),
        );
      },
    }));

    ctx.jobs.worker({
      queue: CHAT_MODERATION_EXPIRY_QUEUE,
      schema: EmptyJobPayloadSchema,
      handler: async () => {
        if (!expiryRef) {
          logger.warn('chat-moderation-expiry sweep skipped - service not constructed');
          return;
        }
        const { mutes, bans, cooldowns } = await expiryRef.sweep();
        if (mutes > 0 || bans > 0 || cooldowns > 0) {
          logger.info({ mutes, bans, cooldowns }, 'chat moderation expiry recorded');
        }
      },
    });

    ctx.jobs.worker({
      queue: CHAT_ROOM_INVITE_EXPIRY_QUEUE,
      schema: EmptyJobPayloadSchema,
      handler: async () => {
        if (!inviteRef) {
          logger.warn('chat-room-invite-expiry sweep skipped - service not constructed');
          return;
        }
        const expired = await inviteRef.expireLapsedInvites();
        if (expired > 0) {
          logger.info({ expired }, 'chat room invites expired');
        }
      },
    });

    let membershipRef: ChatRoomMembershipService | null = null;
    let purgeRef: ChatRoomPurgeService | null = null;
    let jobQueueRef: JobQueueAdapter | null = null;

    const requireJobQueue = (): JobQueueAdapter => {
      if (!jobQueueRef) {
        throw new Error('chat job queue not bound yet');
      }
      return jobQueueRef;
    };

    const onAccountClosed = async (userId: string, envelope?: EventEnvelope) => {
      const closedAt = new Date();
      await requireJobQueue().enqueue(
        CHAT_ACCOUNT_CLOSED_QUEUE,
        { userId, closedAt: closedAt.toISOString() },
        { idempotencyKey: accountJobKey('chat-account-closed', userId, envelope), ...RETRY },
      );
    };

    const onAccountReopened = async (userId: string, envelope?: EventEnvelope) => {
      await requireJobQueue().enqueue(
        CHAT_ACCOUNT_REOPENED_QUEUE,
        { userId },
        { idempotencyKey: accountJobKey('chat-account-reopened', userId, envelope), ...RETRY },
      );
    };

    let systemCardRef: ChatSystemCardService | null = null;

    ctx.events.on('chat.system_message.upserted', async (payload) => {
      if (!systemCardRef) {
        throw new Error('chat system card: service not constructed yet');
      }
      const card = domainEventSchemas['chat.system_message.upserted'].parse(payload);
      const outcome = await systemCardRef.apply(card);
      if (outcome === 'conflict') {
        logger.error(
          { messageId: card.messageId, roomId: card.roomId },
          'chat system card refused: its id names another message',
        );
      } else if (outcome === 'room-gone') {
        logger.warn(
          { messageId: card.messageId, roomId: card.roomId },
          'chat system card dropped: its room no longer exists',
        );
      } else if (outcome === 'stale') {
        logger.debug(
          { messageId: card.messageId, version: card.version },
          'chat system card skipped: a same or newer version is stored',
        );
      }
    });

    let contextRoomsRef: ChatContextRooms | null = null;
    let drizzleRef: DrizzleService | null = null;

    ctx.events.on('chat.context_room.command_issued', async (payload, envelope) => {
      if (!contextRoomsRef || !systemCardRef || !drizzleRef) {
        throw new Error('chat context room command: service not constructed yet');
      }
      const command = domainEventSchemas['chat.context_room.command_issued'].parse(payload);
      await applyContextRoomCommand(
        command,
        { drizzle: drizzleRef, rooms: contextRoomsRef, cards: systemCardRef },
        envelope && new Date(envelope.occurredAt),
      );
    });

    ctx.events.on('player.account.closed', async (payload, envelope) => {
      const parsed = domainEventSchemas['player.account.closed'].safeParse(payload);
      if (parsed.success) {
        await onAccountClosed(parsed.data.userId, envelope);
      }
    });

    ctx.events.on('identity.user.deactivated', async (payload, envelope) => {
      const parsed = domainEventSchemas['identity.user.deactivated'].safeParse(payload);
      if (parsed.success) {
        await onAccountClosed(parsed.data.userId, envelope);
      }
    });

    ctx.events.on('player.account.reopened', async (payload, envelope) => {
      const parsed = domainEventSchemas['player.account.reopened'].safeParse(payload);
      if (parsed.success) {
        await onAccountReopened(parsed.data.userId, envelope);
      }
    });

    ctx.events.on('identity.user.reactivated', async (payload, envelope) => {
      const parsed = domainEventSchemas['identity.user.reactivated'].safeParse(payload);
      if (parsed.success) {
        await onAccountReopened(parsed.data.userId, envelope);
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

    ctx.routers.add('chat', (c, options) => {
      const chatService = createChatService(c);
      expiryRef = new ChatModerationExpiryService(c.get(DRIZZLE), c.get(AUDIT_WRITER));
      const expiryCron =
        (c.has(PLATFORM_CONFIG) ? c.get(PLATFORM_CONFIG).chat.moderationExpiry?.cron : undefined) ??
        CHAT_MODERATION_EXPIRY_DEFAULT_CRON;
      const schedules = options?.mounted !== false;
      if (schedules) {
        void c
          .get(JOB_QUEUE)
          .schedule(
            CHAT_MODERATION_EXPIRY_QUEUE,
            'chat-moderation-expiry.cron',
            {},
            { cron: expiryCron },
          )
          .catch((err: unknown) => logger.error({ err }, 'chat-moderation-expiry schedule failed'));
      }
      const membershipService = createMembershipService(c);
      membershipRef = membershipService;
      purgeRef = new ChatRoomPurgeService(
        c.get(DRIZZLE),
        c.get(EVENT_BUS),
        c.get(CHAT_REALTIME_TRANSPORT),
        c.get(AUDIT_WRITER),
      );
      jobQueueRef = c.get(JOB_QUEUE);
      systemCardRef = new ChatSystemCardService(c.get(DRIZZLE), c.get(CHAT_REALTIME_TRANSPORT));
      contextRoomsRef = c.get(CHAT_CONTEXT_ROOMS);
      drizzleRef = c.get(DRIZZLE);
      if (schedules) {
        void jobQueueRef
          .schedule(
            CHAT_ROOM_PURGE_SCAN_QUEUE,
            'chat-room-purge.cron',
            {},
            { cron: CHAT_ROOM_PURGE_CRON, timezone: CHAT_ROOM_PURGE_TIMEZONE },
          )
          .catch((err: unknown) => logger.error({ err }, 'chat-room-purge schedule failed'));
      }
      inviteRef = new ChatRoomInviteService(
        c.get(DRIZZLE),
        c.get(EVENT_BUS),
        c.get(ACCOUNT_READER),
        membershipService,
        identity || !c.has(PLAY_ELIGIBILITY) ? undefined : c.get(PLAY_ELIGIBILITY),
      );
      if (schedules) {
        void jobQueueRef
          .schedule(
            CHAT_ROOM_INVITE_EXPIRY_QUEUE,
            'chat-room-invite-expiry.cron',
            {},
            { cron: CHAT_ROOM_INVITE_EXPIRY_CRON, timezone: CHAT_ROOM_PURGE_TIMEZONE },
          )
          .catch((err: unknown) =>
            logger.error({ err }, 'chat-room-invite-expiry schedule failed'),
          );
      }
      return createChatRouter({
        chatService,
        membershipService,
        inviteService: inviteRef,
        roomBanService: new ChatRoomBanService(
          c.get(DRIZZLE),
          c.get(EVENT_BUS),
          c.get(AUDIT_WRITER),
          c.get(CHAT_REALTIME_TRANSPORT),
          playerIdsOf(c.get(ACCOUNT_READER), logger),
        ),
        roomMuteService: new ChatRoomMuteService(c.get(DRIZZLE), c.get(AUDIT_WRITER)),
        restrictionService: new ChatRoomRestrictionService(c.get(DRIZZLE), c.get(ACCOUNT_READER)),
        moderationService: c.get(CHAT_MODERATION),
        authorizer: c.get(CHAT_REALTIME_CLIENT_AUTHORIZER),
        adminGuard: c.get(ADMIN_GUARD),
        limiter: c.get(RATE_LIMITER),
      });
    });
  },
} as const satisfies Plugin<CoreTokenCatalog>;

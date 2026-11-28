import * as z from 'zod';
import {
  AUDIT_READER,
  AUDIT_WRITER,
  CACHE,
  IDENTITY_READER,
  JOB_QUEUE,
  PLAYER_ACCOUNT_MANAGER_READER,
  RATE_LIMITER,
  RG_EXCLUSION_READER,
  SUPPORT_CHAT_PROVIDER,
  SUPPORT_HISTORY_READER,
  UuidSchema,
  WALLET_READER,
  PLAYER_RANK_READER,
  domainEventSchemas,
  queue,
  type DomainEventName,
  type JobQueueAdapter,
  type Uuid,
} from '@openora/core/contracts';
import {
  ADMIN_GUARD,
  DRIZZLE,
  EVENT_BUS,
  createLogger,
  type CoreTokenCatalog,
  type DrizzleService,
  type Plugin,
} from '@openora/core/server';
import { SupportChatService, hasLinkedCustomer } from './service/support-chat.service.js';
import { SupportHistoryService } from './service/support-history.service.js';
import { createSupportChatRouter } from './router/index.js';

const logger = createLogger('support-chat');

const SYNC_QUEUE = queue('support-chat.sync-customer');
const SyncJobSchema = z.object({ userId: UuidSchema });
const SYNC_ENQUEUE_OPTIONS = {
  attempts: 10,
  backoff: { type: 'exponential', delayMs: 30_000 },
} as const;
const RESYNC_EVERY_MS = 60 * 60_000;
const RESYNC_RETRY_PAUSE_MS = 1_000;

const SYNC_TOPICS = [
  'support_chat.customer.linked',
  'rg.self_exclusion.activated',
  'rg.self_exclusion.lifted',
  'rg.cooling_off.activated',
  'rg.cooling_off.expired',
  'rg.cooling_off.lifted',
  'player.status.changed',
  'player.account.closed',
  'player.account.reopened',
  'compliance.kyc.updated',
  'promo.rank.changed',
  'identity.email.changed',
  'player.account_manager.changed',
] as const satisfies readonly DomainEventName[];

export default {
  id: 'support-chat',
  dependsOn: ['identity', 'profile', 'compliance', 'audit'],
  requiresPorts: [WALLET_READER, PLAYER_RANK_READER],
  register(ctx) {
    let jobQueue: JobQueueAdapter | null = null;
    let drizzle: DrizzleService | null = null;
    let service: SupportChatService | null = null;

    const scheduleSync = async (userId: Uuid) => {
      if (!jobQueue) {
        throw new Error('support-chat job queue not bound yet');
      }
      await jobQueue.enqueue(SYNC_QUEUE, { userId }, SYNC_ENQUEUE_OPTIONS);
    };

    const scheduleResync = async (userId: Uuid) => {
      if (!jobQueue) {
        throw new Error('support-chat job queue not bound yet');
      }
      const slot = Math.floor(Date.now() / RESYNC_EVERY_MS) + 1;
      await jobQueue.enqueue(
        SYNC_QUEUE,
        { userId },
        {
          attempts: 1,
          delayMs: slot * RESYNC_EVERY_MS - Date.now(),
          idempotencyKey: `support-chat-resync:${userId}:${slot}`,
        },
      );
    };

    ctx.jobs.worker({
      queue: SYNC_QUEUE,
      schema: SyncJobSchema,
      handler: async ({ payload, attempt }) => {
        if (!service) {
          logger.warn(
            { userId: payload.userId, attempt },
            'support-chat sync attempt failed - no SUPPORT_CHAT_PROVIDER bound in this process',
          );
          throw new Error('support-chat sync needs a SUPPORT_CHAT_PROVIDER, none bound here');
        }
        await service.syncCustomer(payload.userId).catch((err: unknown) => {
          logger.warn({ err, userId: payload.userId, attempt }, 'support-chat sync attempt failed');
          throw err;
        });
      },
      onDeadLetter: async ({ payload, id }, error) => {
        logger.error(
          { err: error, userId: payload.userId, jobId: id },
          'support-chat sync gave up - support may see stale context until the hourly resync lands',
        );
        await scheduleResync(payload.userId)
          .catch(async () => {
            await new Promise((resolve) => setTimeout(resolve, RESYNC_RETRY_PAUSE_MS));
            await scheduleResync(payload.userId);
          })
          .catch((err: unknown) =>
            logger.error(
              { err, userId: payload.userId },
              'support-chat resync not scheduled - support may see stale context until the next refresh',
            ),
          );
      },
    });

    const refreshOn =
      <K extends (typeof SYNC_TOPICS)[number]>(topic: K) =>
      async (payload: unknown) => {
        const parsed = domainEventSchemas[topic].safeParse(payload);
        if (!parsed.success) {
          logger.error({ topic }, 'support-chat refresh skipped - event payload failed validation');
          return;
        }
        if (!jobQueue || !drizzle) {
          throw new Error(`support-chat refresh for '${topic}' - job queue not bound yet`);
        }
        const { userId } = parsed.data;
        if (!(await hasLinkedCustomer(drizzle, userId))) {
          return;
        }
        await scheduleSync(userId);
      };
    for (const topic of SYNC_TOPICS) {
      ctx.events.on(topic, refreshOn(topic));
    }

    ctx.routers.add('supportChat', (c) => {
      jobQueue = c.get(JOB_QUEUE);
      drizzle = c.get(DRIZZLE);
      if (c.has(SUPPORT_CHAT_PROVIDER)) {
        const provider = c.get(SUPPORT_CHAT_PROVIDER);
        service = new SupportChatService({
          drizzle,
          audit: c.get(AUDIT_WRITER),
          events: c.get(EVENT_BUS),
          identityReader: c.get(IDENTITY_READER),
          walletReader: c.get(WALLET_READER),
          rankReader: c.get(PLAYER_RANK_READER),
          rgExclusionReader: c.get(RG_EXCLUSION_READER),
          accountManagerReader: c.has(PLAYER_ACCOUNT_MANAGER_READER)
            ? c.get(PLAYER_ACCOUNT_MANAGER_READER)
            : null,
          provider,
          scheduleSync,
        });
        if (!provider.createTicket) {
          logger.warn(
            'SUPPORT_CHAT_PROVIDER has no createTicket - /support-chat/tickets answers not configured',
          );
        }
      } else {
        logger.warn(
          'no SUPPORT_CHAT_PROVIDER bound - /support-chat/session and /support-chat/tickets answer not configured',
        );
      }
      const history = c.has(SUPPORT_HISTORY_READER)
        ? new SupportHistoryService({
            drizzle,
            cache: c.get(CACHE),
            reader: c.get(SUPPORT_HISTORY_READER),
            audit: c.get(AUDIT_READER),
          })
        : null;
      if (!history) {
        logger.warn(
          'no SUPPORT_HISTORY_READER bound - /support-chat/admin/players/{userId}/history answers not configured',
        );
      }
      return createSupportChatRouter({
        session: service,
        history,
        limiter: c.get(RATE_LIMITER),
        adminGuard: c.get(ADMIN_GUARD),
      });
    });
  },
} as const satisfies Plugin<CoreTokenCatalog>;

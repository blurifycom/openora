import * as z from 'zod';
import {
  AUDIT_WRITER,
  IDENTITY_READER,
  JOB_QUEUE,
  RATE_LIMITER,
  RG_EXCLUSION_READER,
  SUPPORT_CHAT_PROVIDER,
  UuidSchema,
  WALLET_READER,
  SupportChatProviderError,
  domainEventSchemas,
  queue,
  type DomainEventName,
  type JobQueueAdapter,
  type Uuid,
} from '@openora/core/contracts';
import {
  DRIZZLE,
  EVENT_BUS,
  createLogger,
  type CoreTokenCatalog,
  type DrizzleService,
  type Plugin,
} from '@openora/core/server';
import { SupportChatService, hasLinkedCustomer } from './service/support-chat.service.js';
import { createSupportChatRouter } from './router/index.js';

const logger = createLogger('support-chat');

const SYNC_QUEUE = queue('support-chat.sync-customer');
const SyncJobSchema = z.object({ userId: UuidSchema });
// 30s doubling over 10 attempts: the last retry runs about 4h after the first failure.
const SYNC_ENQUEUE_OPTIONS = {
  attempts: 10,
  backoff: { type: 'exponential', delayMs: 30_000 },
} as const;
// Once those retries run out, one try at the top of each hour until a sync lands.
const RESYNC_EVERY_MS = 60 * 60_000;
const RESYNC_RETRY_PAUSE_MS = 1_000;

// What refreshes a linked player's context besides a chat open, the first link included.
// Username and active-currency changes emit no event; the next open picks them up.
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
] as const satisfies readonly DomainEventName[];

export default {
  id: 'support-chat',
  dependsOn: ['identity', 'profile', 'gamification', 'wallet', 'compliance', 'audit'],
  register(ctx) {
    // Set by the router factory, which runs after subscriptions are wired but before any
    // event or job arrives (see create-app.ts boot order).
    let jobQueue: JobQueueAdapter | null = null;
    let drizzle: DrizzleService | null = null;
    let service: SupportChatService | null = null;

    const scheduleSync = async (userId: Uuid) => {
      if (!jobQueue) {
        throw new Error('support-chat job queue not bound yet');
      }
      await jobQueue.enqueue(SYNC_QUEUE, { userId }, SYNC_ENQUEUE_OPTIONS);
    };

    // A self-excluded player cannot sign in to refresh it, so support would see stale RG state
    // for good. The key names the hour: every give-up in that hour shares one job, and the key
    // is never reused while the queue still keeps the failed job.
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

    // No orderingKey: the shipped drivers do not honour it. Two syncs for one player may run
    // at once; syncCustomer re-reads after each write, so the last write still converges.
    ctx.jobs.worker({
      queue: SYNC_QUEUE,
      schema: SyncJobSchema,
      handler: async ({ payload, attempt }) => {
        if (!service) {
          // Another process may have the provider bound: fail so the queue retries the job there
          // instead of acking a sync that never ran.
          logger.warn(
            { userId: payload.userId, attempt },
            'support-chat sync attempt failed - no SUPPORT_CHAT_PROVIDER bound in this process',
          );
          throw new Error('support-chat sync needs a SUPPORT_CHAT_PROVIDER, none bound here');
        }
        await service.syncCustomer(payload.userId).catch((err: unknown) => {
          // A provider error carries its short reason only: its `cause` may hold vendor detail.
          const detail = err instanceof SupportChatProviderError ? { reason: err.reason } : { err };
          logger.warn(
            { ...detail, userId: payload.userId, attempt },
            'support-chat sync attempt failed',
          );
          throw err instanceof SupportChatProviderError
            ? new SupportChatProviderError(err.reason)
            : err;
        });
      },
      // Scheduled whichever process gives up: one without the provider cannot tell a fleet where
      // another process has it from one where none does, so the resync stays owed either way.
      onDeadLetter: async ({ payload, id }, error) => {
        logger.error(
          { err: error, userId: payload.userId, jobId: id },
          'support-chat sync gave up - support may see stale context until the hourly resync lands',
        );
        // The driver only logs a hook that throws, so a refused enqueue would end the chain: try
        // once more after a pause, then say plainly the context is stranded.
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

    // Throws while the queue is not bound yet, so the broker redelivers the event rather than
    // it being marked handled (ADR-0045). A player who never opened the chat has nothing to
    // refresh. A linked one gets a job even where no provider is bound: another process may have
    // one, and the worker retries until it does.
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
      const limiter = c.get(RATE_LIMITER);
      if (!c.has(SUPPORT_CHAT_PROVIDER)) {
        logger.warn(
          'no SUPPORT_CHAT_PROVIDER bound - /support-chat/session answers not configured',
        );
        return createSupportChatRouter(null, limiter);
      }
      service = new SupportChatService({
        drizzle,
        audit: c.get(AUDIT_WRITER),
        events: c.get(EVENT_BUS),
        identityReader: c.get(IDENTITY_READER),
        walletReader: c.get(WALLET_READER),
        rgExclusionReader: c.get(RG_EXCLUSION_READER),
        provider: c.get(SUPPORT_CHAT_PROVIDER),
        scheduleSync,
      });
      return createSupportChatRouter(service, limiter);
    });
  },
} as const satisfies Plugin<CoreTokenCatalog>;

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
import { DRIZZLE, EVENT_BUS, createLogger } from '@openora/core/server';
import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { SupportChatService } from './service/support-chat.service.js';
import { createSupportChatRouter } from './router/index.js';

const logger = createLogger('support-chat');

const SYNC_QUEUE = queue('support-chat.sync-customer');
const SyncJobSchema = z.object({ userId: UuidSchema });
// 30s doubling over 10 attempts: the last retry runs about 4h after the first failure.
const SYNC_ENQUEUE_OPTIONS = {
  attempts: 10,
  backoff: { type: 'exponential', delayMs: 30_000 },
} as const;

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
    let service: SupportChatService | null = null;

    const scheduleSync = async (userId: Uuid) => {
      if (!jobQueue) {
        throw new Error('support-chat job queue not bound yet');
      }
      await jobQueue.enqueue(SYNC_QUEUE, { userId }, SYNC_ENQUEUE_OPTIONS);
    };

    // No orderingKey: the shipped drivers do not honour it. Two syncs for one player may run
    // at once; syncCustomer re-reads after each write, so the last write still converges.
    ctx.jobs.worker({
      queue: SYNC_QUEUE,
      schema: SyncJobSchema,
      handler: async ({ payload, attempt }) => {
        if (!service) {
          return;
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
      onDeadLetter: ({ payload }) => {
        logger.error(
          { userId: payload.userId },
          'support-chat sync gave up - support sees stale context until the next refresh',
        );
      },
    });

    // Throws while the queue is not bound yet, so the broker redelivers the event rather than
    // it being marked handled (ADR-0045). With no provider bound, or a player who never opened
    // the chat, there is nothing to refresh.
    const refreshOn =
      <K extends (typeof SYNC_TOPICS)[number]>(topic: K) =>
      async (payload: unknown) => {
        const parsed = domainEventSchemas[topic].safeParse(payload);
        if (!parsed.success) {
          logger.error({ topic }, 'support-chat refresh skipped - event payload failed validation');
          return;
        }
        if (!jobQueue) {
          throw new Error(`support-chat refresh for '${topic}' - job queue not bound yet`);
        }
        const { userId } = parsed.data;
        if (!service || !(await service.hasLinkedCustomer(userId))) {
          return;
        }
        await scheduleSync(userId);
      };
    for (const topic of SYNC_TOPICS) {
      ctx.events.on(topic, refreshOn(topic));
    }

    ctx.routers.add('supportChat', (c) => {
      jobQueue = c.get(JOB_QUEUE);
      const limiter = c.get(RATE_LIMITER);
      if (!c.has(SUPPORT_CHAT_PROVIDER)) {
        logger.warn(
          'no SUPPORT_CHAT_PROVIDER bound - /support-chat/session answers not configured',
        );
        return createSupportChatRouter(null, limiter);
      }
      service = new SupportChatService({
        drizzle: c.get(DRIZZLE),
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

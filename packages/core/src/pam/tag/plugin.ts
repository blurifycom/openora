import { definePlugin, EVENT_BUS, DRIZZLE, ADMIN_GUARD } from '@blurifycom/core/server';
import { WALLET_READER, IDENTITY_READER, JOB_QUEUE, queue } from '@blurifycom/core/contracts';
import z from 'zod';
import { TagService } from './service/tag.service.js';
import { TagRuleService } from './service/tag-rule.service.js';
import { TagEvaluationService } from './service/tag-evaluation.service.js';
import { createTagRouter } from './router/index.js';

export default definePlugin({
  id: 'tag',
  dependsOn: ['wallet', 'identity'],
  register(ctx) {
    let tagEvaluationService: TagEvaluationService | null = null;

    ctx.events.on('wallet.deposit.completed', (p) => tagEvaluationService?.onDepositCompleted(p));
    ctx.events.on('wallet.withdrawal.completed', (p) =>
      tagEvaluationService?.onWithdrawalCompleted(p),
    );
    ctx.events.on('identity.user.login', (p) => tagEvaluationService?.onUserLogin(p));
    ctx.events.on('compliance.kyc.submitted', (p) => tagEvaluationService?.onKycSubmitted(p));
    ctx.events.on('compliance.kyc.updated', (p) => tagEvaluationService?.onKycStatusUpdated(p));

    // Daily inactive-player sweep. schedule() is called in the router factory (container access).
    ctx.jobs.worker({
      queue: queue('tag.daily-evaluation'),
      schema: z.object({}),
      handler: async () => {
        await tagEvaluationService?.runDailyEvaluation();
      },
    });

    ctx.routers.add('tag', (c) => {
      const tagSvc = new TagService(c.get(DRIZZLE), c.get(EVENT_BUS));
      const ruleSvc = new TagRuleService(c.get(DRIZZLE), c.get(EVENT_BUS));
      const evalSvc = new TagEvaluationService(
        tagSvc,
        ruleSvc,
        c.get(WALLET_READER),
        c.get(IDENTITY_READER),
      );
      tagEvaluationService = evalSvc;

      // Idempotent daily schedule (keyed by scheduleId). In-process driver runs it
      // manually; a durable overlay (BullMQ) fires at cron time.
      void c
        .get(JOB_QUEUE)
        .schedule(
          queue('tag.daily-evaluation'),
          'tag.daily-evaluation.daily',
          {},
          { cron: '0 2 * * *' },
        );

      return createTagRouter(tagSvc, ruleSvc, c.get(ADMIN_GUARD));
    });
  },
});

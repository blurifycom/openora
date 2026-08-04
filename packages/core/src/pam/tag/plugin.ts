import {
  definePlugin,
  EVENT_BUS,
  DRIZZLE,
  ADMIN_GUARD,
  type TypedContainer,
  CORE_TOKEN_CATALOG,
  type CoreTokenCatalog,
} from '@openora/core/server';
import {
  PLAYER_TAGS,
  TAG_EVALUATION_COMMANDS,
  WALLET_READER,
  IDENTITY_READER,
  ADMIN_USER_DIRECTORY,
  JOB_QUEUE,
  queue,
} from '@openora/core/contracts';
import z from 'zod';
import { TagService } from './service/tag.service.js';
import { TagRuleService } from './service/tag-rule.service.js';
import { TagEvaluationService } from './service/tag-evaluation.service.js';
import { createTagRouter } from './router/index.js';

export default definePlugin(CORE_TOKEN_CATALOG, {
  id: 'tag',
  dependsOn: ['wallet', 'identity'],
  register(ctx) {
    // One memoized instance backs the PLAYER_TAGS port and the router closure.
    let svc: TagService | null = null;
    const tagService = (c: TypedContainer<CoreTokenCatalog>) =>
      (svc ??= new TagService(c.get(DRIZZLE), c.get(EVENT_BUS)));

    // One memoized instance backs the router closure and the TAG_EVALUATION_COMMANDS port.
    let ruleSvc: TagRuleService | null = null;
    const ruleService = (c: TypedContainer<CoreTokenCatalog>) =>
      (ruleSvc ??= new TagRuleService(c.get(DRIZZLE), c.get(EVENT_BUS)));

    // One memoized instance backs the daily job, the event subscriptions below, and the
    // TAG_EVALUATION_COMMANDS port - constructed lazily on first access (via either the
    // provide() factory or the router factory, whichever runs first) rather than only
    // inside the router factory, so wallet's synchronous TAG_EVALUATION_COMMANDS call is
    // never blocked on this module's own router having mounted first.
    let evalSvc: TagEvaluationService | null = null;
    const tagEvaluationService = (c: TypedContainer<CoreTokenCatalog>) =>
      (evalSvc ??= new TagEvaluationService({
        tag: tagService(c),
        rule: ruleService(c),
        walletReader: c.get(WALLET_READER),
        identityReader: c.get(IDENTITY_READER),
        adminUserDirectory: c.get(ADMIN_USER_DIRECTORY),
      }));

    ctx.provide(PLAYER_TAGS, tagService);
    // Synchronous counterpart to the wallet.withdrawal.requested subscription below - see
    // TagEvaluationService.evaluateWithdrawalRequested for why auto-approval can't rely on
    // the async event handler alone. ADR-0017.
    ctx.provide(TAG_EVALUATION_COMMANDS, (c) => ({
      evaluateWithdrawalRequested: (tx, args) =>
        tagEvaluationService(c).evaluateWithdrawalRequested(tx, args),
    }));

    ctx.events.on('wallet.deposit.completed', (p) => evalSvc?.onDepositCompleted(p));
    ctx.events.on('wallet.withdrawal.completed', (p) => evalSvc?.onWithdrawalCompleted(p));
    ctx.events.on('wallet.withdrawal.requested', (p) => evalSvc?.onWithdrawalRequested(p));
    ctx.events.on('identity.user.login', (p) => evalSvc?.onUserLogin(p));
    ctx.events.on('identity.user.phone_login', (p) => evalSvc?.onUserPhoneLogin(p));
    ctx.events.on('compliance.kyc.submitted', (p) => evalSvc?.onKycSubmitted(p));
    ctx.events.on('compliance.kyc.updated', (p) => evalSvc?.onKycStatusUpdated(p));
    ctx.events.on('compliance.kyc.reverify_required', (p) => evalSvc?.onKycReverifyRequired(p));
    ctx.events.on('compliance.kyc.high_risk_signal_detected', (p) =>
      evalSvc?.onKycHighRiskSignalDetected(p),
    );
    ctx.events.on('rg.self_exclusion.activated', (p) => evalSvc?.onSelfExclusionActivated(p));
    ctx.events.on('rg.self_exclusion.lifted', (p) => evalSvc?.onSelfExclusionLifted(p));
    ctx.events.on('player.level.changed', (p) => evalSvc?.onPlayerLevelChanged(p));

    // Daily inactive-player sweep. schedule() is called in the router factory (container access).
    ctx.jobs.worker({
      queue: queue('tag.daily-evaluation'),
      schema: z.object({}),
      handler: async () => {
        await evalSvc?.runDailyEvaluation();
      },
    });

    ctx.routers.add('tag', (c) => {
      const tagSvc = tagService(c);
      const ruleSvcForRouter = ruleService(c);
      tagEvaluationService(c); // ensure evalSvc is constructed for the event handlers/job worker above

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

      return createTagRouter(tagSvc, ruleSvcForRouter, c.get(ADMIN_GUARD));
    });
  },
});

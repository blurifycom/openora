import { createHash } from 'node:crypto';
import { implement, ORPCError } from '@orpc/server';
import {
  AdminGuard,
  createEventStreamGenerator,
  getUserId,
  mapErrors,
  type OssContext,
} from '@openora/core/server';
import type {
  AuditWritePort,
  JobQueueAdapter,
  KycAdapter,
  KycWebhookVerifier,
  QueueName,
  RealtimeTransport,
  User,
} from '@openora/core/contracts';
import { complianceContract, type KycStatusUpdate } from '../contract/index.js';
import {
  ComplianceService,
  LimitNotFoundError,
  LimitOwnershipError,
} from '../service/compliance.service.js';
import { KycVerificationService, PlayerNotFoundError } from '../service/kyc.service.js';
import {
  RgService,
  ExclusionNotFoundError,
  ActiveExclusionError,
  PermanentExclusionLiftError,
  ExclusionPeriodNotElapsedError,
  LimitRaiseNotAllowedError,
} from '../service/rg.service.js';
import { RgMonitoringService } from '../service/rg-monitoring.service.js';
import {
  RgSelfServiceService,
  CooldownNotElapsedError,
  LimitChangeExpiredError,
  NoPendingLimitChangeError,
} from '../service/rg-self-service.service.js';

export function kycStatusChannel(userId: User['id']): string {
  return `compliance:kyc-status:${userId}`;
}

export function createKycStatusStream(
  realtime: RealtimeTransport,
  userId: User['id'],
  signal: AbortSignal | undefined,
): AsyncGenerator<KycStatusUpdate> {
  return createEventStreamGenerator(
    (push) => realtime.subscribe<KycStatusUpdate>(kycStatusChannel(userId), push),
    { signal },
  );
}

export function createComplianceRouter({
  compliance,
  adminGuard,
  audit,
  kyc,
  kycAdapter,
  webhookVerifier,
  jobQueue,
  kycDecisionSyncQueue,
  realtime,
  rg,
  rgMonitoring,
  rgSelfService,
}: {
  rg: RgService;
  rgMonitoring: RgMonitoringService;
  rgSelfService: RgSelfServiceService;
  compliance: ComplianceService;
  adminGuard: AdminGuard;
  audit: AuditWritePort;
  kyc: KycVerificationService;
  kycAdapter: KycAdapter;
  webhookVerifier: KycWebhookVerifier;
  jobQueue: JobQueueAdapter;
  kycDecisionSyncQueue: QueueName;
  realtime: RealtimeTransport;
}) {
  const os = implement(complianceContract).$context<OssContext>();

  return os.router({
    getLimits: os.getLimits.handler(({ context }) => rgSelfService.getLimits(getUserId(context))),

    // Immediate for a first limit or a lower one; files a cool-down request for a raise.
    upsertLimit: os.upsertLimit.handler(({ input, context }) => {
      return rgSelfService.upsertLimit(getUserId(context), input, context.clientMeta);
    }),

    // Files a removal request - the limit keeps applying until the player confirms it.
    deleteLimit: os.deleteLimit.handler(({ input, context }) => {
      return mapErrors({ NOT_FOUND: LimitNotFoundError, FORBIDDEN: LimitOwnershipError }, () =>
        rgSelfService.requestLimitRemoval(input.id, getUserId(context), context.clientMeta),
      );
    }),

    geoCheck: os.geoCheck.handler(({ context }) => {
      const { ip } = context.clientMeta;
      return compliance.geoCheck(ip ?? '127.0.0.1');
    }),

    addGeoRule: os.addGeoRule.handler(async ({ input, context }) => {
      const { userId, ip, userAgent } = await adminGuard.assert(
        context,
        'compliance',
        'override-limit',
      );
      return compliance.addGeoRule(input, userId, { ip, userAgent });
    }),

    listGeoRules: os.listGeoRules.handler(async ({ context }) => {
      await adminGuard.assert(context, 'compliance', 'view');
      return compliance.listGeoRules();
    }),

    getPlayerKyc: os.getPlayerKyc.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'compliance', 'view');
      return kyc.getForPlayer(input.userId);
    }),

    submitKyc: os.submitKyc.handler(({ input, context }) => {
      return kyc.submit(getUserId(context), input, context.clientMeta);
    }),

    streamKycStatus: os.streamKycStatus.handler(({ signal, context }) => {
      return createKycStatusStream(realtime, getUserId(context), signal);
    }),

    // M2M provider webhook - no admin session. Verify the verbatim bytes against the
    // signature header or reject (fail closed); never fall back to an empty body.
    kycWebhook: os.kycWebhook.handler(async ({ context }) => {
      const rawBody = context.rawBody;
      if (
        rawBody === undefined ||
        !(await webhookVerifier.verify(rawBody, context.request.headers))
      ) {
        throw new ORPCError('UNAUTHORIZED', { message: 'Invalid KYC webhook signature' });
      }
      const decision = kycAdapter.parseWebhook?.(rawBody, context.request.headers);
      if (decision) {
        // Dedup on a hash of the verbatim delivery bytes, never on referenceId:status.
        // The vendor-neutral KycResult carries no delivery/event id, so the only
        // signal that reliably distinguishes "the SAME decision resent" (retry storm
        // within the vendor's own SLA - collapse it) from "a genuinely NEW decision
        // that happens to land on a status we've seen before" (eg
        // rejected -> approved -> rejected again - must run) is the raw body itself:
        // a true redelivery is byte-identical: a new decision is not. Keying on
        // referenceId:status instead would give BullMQ's permanent-by-default jobId
        // dedup (see bullmq-job-queue.ts) a key that legitimately repeats, silently
        // dropping the later, real decision forever.
        const idempotencyKey = `kyc-decision-sync:${createHash('sha256').update(rawBody).digest('hex')}`;
        // Stamped HERE, at webhook-arrival time - never in the job handler - so the
        // reconcile monotonicity guard has the true delivery order even when the job
        // queue (which ignores orderingKey) runs two decisions for the same reference
        // out of order.
        const receivedAt = new Date().toISOString();
        await jobQueue.enqueue(
          kycDecisionSyncQueue,
          { referenceId: decision.referenceId, status: decision.status, receivedAt },
          {
            idempotencyKey,
            orderingKey: decision.referenceId,
            attempts: 5,
            backoff: { type: 'exponential', delayMs: 1_000 },
          },
        );
      }
      return { ok: true as const };
    }),

    requestKycResubmission: os.requestKycResubmission.handler(async ({ input, context }) => {
      const caller = await adminGuard.assert(context, 'compliance', 'override-limit');
      return mapErrors({ NOT_FOUND: PlayerNotFoundError }, () =>
        kyc.requestResubmission(input.userId, input.reason, caller.userId),
      );
    }),

    overrideKycStatus: os.overrideKycStatus.handler(async ({ input, context }) => {
      const caller = await adminGuard.assert(context, 'compliance', 'override-limit');
      return mapErrors({ NOT_FOUND: PlayerNotFoundError }, () =>
        kyc.overrideStatus(input.userId, input.status, input.reason, caller.userId),
      );
    }),

    bulkApproveKyc: os.bulkApproveKyc.handler(async ({ input, context }) => {
      const caller = await adminGuard.assert(context, 'compliance', 'override-limit');
      const results = await kyc.bulkApprove(input.userIds, input.reason, caller.userId);
      // A per-item failure never reaches overrideStatus, so it leaves no
      // compliance.kyc.updated trail of its own - record the WHOLE attempted batch here
      // (every userId, success/failure per item) so a probe of nonexistent ids is still
      // visible in the audit log even when nothing downstream changed.
      await audit.record({
        actorId: caller.userId,
        actorType: 'admin',
        action: 'compliance.kyc.bulk_approve',
        resourceType: 'compliance',
        resourceId: null,
        after: { reason: input.reason, results },
      });
      return { results };
    }),

    setPlayerLimit: os.setPlayerLimit.handler(async ({ input, context }) => {
      const { userId, ip, userAgent } = await adminGuard.assert(context, 'compliance', 'manage-rg');
      return mapErrors({ CONFLICT: LimitRaiseNotAllowedError }, () =>
        rg.setPlayerLimit(input.userId, input, userId, 'admin', { ip, userAgent }),
      );
    }),

    activateCoolingOff: os.activateCoolingOff.handler(async ({ input, context }) => {
      const { userId, ip, userAgent } = await adminGuard.assert(context, 'compliance', 'manage-rg');
      return mapErrors({ CONFLICT: ActiveExclusionError }, () =>
        rg.activateCoolingOff(input.userId, input, userId, 'admin', { ip, userAgent }),
      );
    }),

    activateSelfExclusion: os.activateSelfExclusion.handler(async ({ input, context }) => {
      const { userId, ip, userAgent } = await adminGuard.assert(context, 'compliance', 'manage-rg');
      return mapErrors({ CONFLICT: ActiveExclusionError }, () =>
        rg.activateSelfExclusion(input.userId, input, userId, 'admin', { ip, userAgent }),
      );
    }),

    liftSelfExclusion: os.liftSelfExclusion.handler(async ({ input, context }) => {
      const { userId, ip, userAgent } = await adminGuard.assert(context, 'compliance', 'manage-rg');
      return mapErrors(
        {
          NOT_FOUND: ExclusionNotFoundError,
          CONFLICT: [PermanentExclusionLiftError, ExclusionPeriodNotElapsedError],
        },
        () => rg.liftSelfExclusion(input.userId, input, userId, { ip, userAgent }),
      );
    }),

    liftCoolingOff: os.liftCoolingOff.handler(async ({ input, context }) => {
      const { userId, ip, userAgent } = await adminGuard.assert(context, 'compliance', 'manage-rg');
      return mapErrors({ NOT_FOUND: ExclusionNotFoundError }, () =>
        rg.liftCoolingOff(input.userId, input, userId, { ip, userAgent }),
      );
    }),

    getRgSection: os.getRgSection.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'compliance', 'view');
      return rgSelfService.getSection(input.userId);
    }),

    listRgFlags: os.listRgFlags.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'compliance', 'view');
      return rgMonitoring.listFlags(input);
    }),

    // Player self-service. Every handler below resolves the subject from the SESSION and
    // none of them reads a userId from input: a player acts on themselves and nobody
    // else. Lifting an exclusion stays admin-only and has no self-service counterpart.
    getMyRgSection: os.getMyRgSection.handler(({ context }) =>
      rgSelfService.getSection(getUserId(context)),
    ),

    confirmPendingLimitChange: os.confirmPendingLimitChange.handler(({ input, context }) =>
      mapErrors(
        {
          NOT_FOUND: [LimitNotFoundError, NoPendingLimitChangeError],
          FORBIDDEN: LimitOwnershipError,
          CONFLICT: [CooldownNotElapsedError, LimitChangeExpiredError],
        },
        () => rgSelfService.confirmPendingChange(input.id, getUserId(context), context.clientMeta),
      ),
    ),

    cancelPendingLimitChange: os.cancelPendingLimitChange.handler(({ input, context }) =>
      mapErrors({ NOT_FOUND: LimitNotFoundError, FORBIDDEN: LimitOwnershipError }, () =>
        rgSelfService.cancelPendingChange(input.id, getUserId(context), context.clientMeta),
      ),
    ),

    requestCoolingOff: os.requestCoolingOff.handler(({ input, context }) =>
      mapErrors({ CONFLICT: ActiveExclusionError }, () =>
        rgSelfService.requestCoolingOff(getUserId(context), input, context.clientMeta),
      ),
    ),

    requestSelfExclusion: os.requestSelfExclusion.handler(({ input, context }) =>
      mapErrors({ CONFLICT: ActiveExclusionError }, () =>
        rgSelfService.requestSelfExclusion(getUserId(context), input, context.clientMeta),
      ),
    ),
  });
}

import { implement, ORPCError } from '@orpc/server';
import { AdminGuard, getUserId, mapErrors, type OssContext } from '@blurifycom/core/server';
import type { KycAdapter, KycWebhookVerifier } from '@blurifycom/core/contracts';
import { complianceContract } from '../contract/index.js';
import {
  ComplianceService,
  LimitNotFoundError,
  LimitOwnershipError,
} from '../service/compliance.service.js';
import { KycVerificationService } from '../service/kyc.service.js';
import {
  RgService,
  ExclusionNotFoundError,
  ActiveExclusionError,
  PermanentExclusionLiftError,
  ExclusionPeriodNotElapsedError,
} from '../service/rg.service.js';
import { RgMonitoringService } from '../service/rg-monitoring.service.js';

function headerValue(context: OssContext, name: string): string | null {
  const raw = context.request.headers[name];
  if (Array.isArray(raw)) return raw[0] ?? null;
  return raw ?? null;
}

export function createComplianceRouter({
  compliance,
  adminGuard,
  kyc,
  kycAdapter,
  webhookVerifier,
  rg,
  rgMonitoring,
}: {
  rg: RgService;
  rgMonitoring: RgMonitoringService;
  compliance: ComplianceService;
  adminGuard: AdminGuard;
  kyc: KycVerificationService;
  kycAdapter: KycAdapter;
  webhookVerifier: KycWebhookVerifier;
}) {
  const os = implement(complianceContract).$context<OssContext>();

  return os.router({
    getLimits: os.getLimits.handler(({ context }) =>
      compliance.getLimitsForUser(getUserId(context)),
    ),

    upsertLimit: os.upsertLimit.handler(({ input, context }) =>
      compliance.upsertLimit(getUserId(context), input),
    ),

    deleteLimit: os.deleteLimit.handler(({ input, context }) =>
      mapErrors({ NOT_FOUND: LimitNotFoundError, FORBIDDEN: LimitOwnershipError }, () =>
        compliance.removeLimit(input.id, getUserId(context)),
      ),
    ),

    geoCheck: os.geoCheck.handler(({ context }) => {
      const ip =
        (context.request.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
        '127.0.0.1';
      return compliance.geoCheck(ip);
    }),

    addGeoRule: os.addGeoRule.handler(async ({ input, context }) => {
      const caller = await adminGuard.assert(context, 'compliance', 'override-limit');
      return compliance.addGeoRule(input, caller.userId);
    }),

    listGeoRules: os.listGeoRules.handler(async ({ context }) => {
      await adminGuard.assert(context, 'compliance', 'view');
      return compliance.listGeoRules();
    }),

    getPlayerKyc: os.getPlayerKyc.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'compliance', 'view');
      return kyc.getForPlayer(input.userId);
    }),

    submitKyc: os.submitKyc.handler(({ input, context }) => kyc.submit(getUserId(context), input)),

    // M2M provider webhook - no admin session. Verify the verbatim bytes against the
    // signature header or reject (fail closed); never fall back to an empty body.
    kycWebhook: os.kycWebhook.handler(async ({ context }) => {
      const rawBody = context.rawBody;
      if (
        rawBody === undefined ||
        !webhookVerifier.verify(rawBody, headerValue(context, 'x-kyc-signature'))
      ) {
        throw new ORPCError('UNAUTHORIZED', { message: 'Invalid KYC webhook signature' });
      }
      const decision = kycAdapter.parseWebhook?.(rawBody, context.request.headers);
      if (decision) {
        await kyc.reconcile(decision.referenceId, decision.status);
      }
      return { ok: true as const };
    }),

    setPlayerLimit: os.setPlayerLimit.handler(async ({ input, context }) => {
      const caller = await adminGuard.assert(context, 'compliance', 'manage-rg');
      return rg.setPlayerLimit(input.userId, input, caller.userId);
    }),

    activateCoolingOff: os.activateCoolingOff.handler(async ({ input, context }) => {
      const caller = await adminGuard.assert(context, 'compliance', 'manage-rg');
      return mapErrors({ CONFLICT: ActiveExclusionError }, () =>
        rg.activateCoolingOff(input.userId, input, caller.userId),
      );
    }),

    activateSelfExclusion: os.activateSelfExclusion.handler(async ({ input, context }) => {
      const caller = await adminGuard.assert(context, 'compliance', 'manage-rg');
      return mapErrors({ CONFLICT: ActiveExclusionError }, () =>
        rg.activateSelfExclusion(input.userId, input, caller.userId),
      );
    }),

    liftSelfExclusion: os.liftSelfExclusion.handler(async ({ input, context }) => {
      const caller = await adminGuard.assert(context, 'compliance', 'manage-rg');
      return mapErrors(
        {
          NOT_FOUND: ExclusionNotFoundError,
          CONFLICT: [PermanentExclusionLiftError, ExclusionPeriodNotElapsedError],
        },
        () => rg.liftSelfExclusion(input.userId, input, caller.userId),
      );
    }),

    getRgSection: os.getRgSection.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'compliance', 'view');
      return rg.getRgSection(input.userId);
    }),

    listRgFlags: os.listRgFlags.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'compliance', 'view');
      return rgMonitoring.listFlags(input);
    }),
  });
}

import { implement } from '@orpc/server';
import { AdminGuard } from '@blurifycom/core/server';
import { getUserId, mapErrors, type OssContext } from '@blurifycom/core/server';
import { complianceContract } from '../contract/index.js';
import {
  ComplianceService,
  LimitNotFoundError,
  LimitOwnershipError,
} from '../service/compliance.service.js';

export function createComplianceRouter(compliance: ComplianceService, adminGuard: AdminGuard) {
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
  });
}

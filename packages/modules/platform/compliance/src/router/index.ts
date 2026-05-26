import { Controller } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { AdminGuard } from '@oss/auth';
import { getUserId, mapErrors } from '@oss/core';
import { complianceContract } from '@oss/orpc-contract/compliance';
import type { Request } from 'express';
import {
  ComplianceService,
  LimitNotFoundError,
  LimitOwnershipError,
} from '../service/compliance.service.js';

@Controller()
export class ComplianceController {
  constructor(
    private readonly compliance: ComplianceService,
    private readonly adminGuard: AdminGuard,
  ) {}

  @Implement(complianceContract)
  complianceRouter() {
    return {
      getLimits: implement(complianceContract.getLimits).handler(({ context }) =>
        this.compliance.getLimitsForUser(getUserId(context)),
      ),

      upsertLimit: implement(complianceContract.upsertLimit).handler(({ input, context }) =>
        this.compliance.upsertLimit(getUserId(context), input),
      ),

      deleteLimit: implement(complianceContract.deleteLimit).handler(({ input, context }) =>
        mapErrors(
          { NOT_FOUND: LimitNotFoundError, FORBIDDEN: LimitOwnershipError },
          () => this.compliance.removeLimit(input.id, getUserId(context)),
        ),
      ),

      geoCheck: implement(complianceContract.geoCheck).handler(({ context }) => {
        const req = (context as { request: Request }).request;
        const ip =
          (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
          '127.0.0.1';
        return this.compliance.geoCheck(ip);
      }),

      addGeoRule: implement(complianceContract.addGeoRule).handler(async ({ input, context }) => {
        await this.adminGuard.assert(context);
        return this.compliance.addGeoRule(input);
      }),

      listGeoRules: implement(complianceContract.listGeoRules).handler(async ({ context }) => {
        await this.adminGuard.assert(context);
        return this.compliance.listGeoRules();
      }),
    };
  }
}

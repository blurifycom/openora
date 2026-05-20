import { Controller } from '@nestjs/common';
import { Implement, implement, ORPCError } from '@orpc/nest';
import { complianceContract } from '@oss/orpc-contract/compliance';
import type { Request } from 'express';
import {
  ComplianceService,
  LimitNotFoundError,
  LimitOwnershipError,
} from '../service/compliance.service.js';

@Controller()
export class ComplianceController {
  constructor(private readonly compliance: ComplianceService) {}

  @Implement(complianceContract)
  complianceRouter() {
    return {
      getLimits: implement(complianceContract.getLimits).handler(({ context }) => {
        const req = (context as { request: Request }).request;
        const userId = req.headers['x-user-id'] as string;
        return this.compliance.getLimitsForUser(userId);
      }),

      upsertLimit: implement(complianceContract.upsertLimit).handler(({ input, context }) => {
        const req = (context as { request: Request }).request;
        const userId = req.headers['x-user-id'] as string;
        return this.compliance.upsertLimit(userId, input);
      }),

      deleteLimit: implement(complianceContract.deleteLimit).handler(async ({ input, context }) => {
        const req = (context as { request: Request }).request;
        const userId = req.headers['x-user-id'] as string;
        try {
          return await this.compliance.removeLimit(input.id, userId);
        } catch (err) {
          if (err instanceof LimitNotFoundError) {
            throw new ORPCError('NOT_FOUND', { message: err.message });
          }
          if (err instanceof LimitOwnershipError) {
            throw new ORPCError('FORBIDDEN', { message: err.message });
          }
          throw err;
        }
      }),

      geoCheck: implement(complianceContract.geoCheck).handler(({ context }) => {
        const req = (context as { request: Request }).request;
        const ip =
          (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
          '127.0.0.1';
        return this.compliance.geoCheck(ip);
      }),

      addGeoRule: implement(complianceContract.addGeoRule).handler(({ input }) => {
        return this.compliance.addGeoRule(input);
      }),

      listGeoRules: implement(complianceContract.listGeoRules).handler(() => {
        return this.compliance.listGeoRules();
      }),
    };
  }
}

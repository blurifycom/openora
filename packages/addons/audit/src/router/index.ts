import { implement } from '@orpc/server';
import { AdminGuard } from '@oss/auth';
import { mapErrors, type OssContext } from '@oss/core';
import { auditContract } from '../contract/index.js';
import { AuditService } from '../service/audit.service.js';

export function createAuditRouter(svc: AuditService, adminGuard: AdminGuard) {
  const os = implement(auditContract).$context<OssContext>();

  return os.router({
    list: os.list.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'audit', 'view');
      return mapErrors({}, () => svc.list(input));
    }),

    exportCsv: os.exportCsv.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'audit', 'export');
      const csv = await svc.exportCsv(input);
      return { csv };
    }),
  });
}

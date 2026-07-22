import { implement } from '@orpc/server';
import {
  AdminGuard,
  extractClientMeta,
  getUserId,
  mapErrors,
  type OssContext,
} from '@openora/core/server';
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
      // Record AFTER producing the CSV so an export failure is not logged as a success.
      const { ip, userAgent } = extractClientMeta(context.request.headers);
      await svc.record({
        actorId: getUserId(context),
        actorType: 'admin',
        action: 'audit.export',
        resourceType: 'audit',
        after: { filters: input },
        ip,
        userAgent,
        result: 'success',
      });
      return { csv };
    }),
  });
}

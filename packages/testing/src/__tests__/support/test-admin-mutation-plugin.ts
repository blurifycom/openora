import { ORPCError, os } from '@orpc/server';
import * as z from 'zod';
import {
  ADMIN_GUARD,
  type CoreTokenCatalog,
  type OssContext,
  type Plugin,
} from '@openora/core/server';
import { AUDIT_WRITER } from '@openora/core/contracts';

const route = os.$context<OssContext>();

const MutationInput = z.object({
  targetId: z.uuid(),
  note: z.string(),
  password: z.string().optional(),
});

export default {
  id: 'testing-admin-mutation',
  dependsOn: ['audit', 'iam'],
  register(ctx) {
    ctx.routers.add('testing-admin-mutation', (c) => {
      const adminGuard = c.get(ADMIN_GUARD);
      const writer = c.get(AUDIT_WRITER);
      return {
        silent: route
          .route({ method: 'POST', path: '/testing/admin-mutation/silent' })
          .input(MutationInput)
          .handler(async ({ context }) => {
            await adminGuard.assert(context, 'content', 'update');
            return { ok: true };
          }),
        ownAudit: route
          .route({ method: 'POST', path: '/testing/admin-mutation/own-audit' })
          .input(MutationInput)
          .handler(async ({ context, input }) => {
            const caller = await adminGuard.assert(context, 'content', 'update');
            await writer.record({
              actorId: caller.userId,
              actorType: 'admin',
              action: 'testing.admin_mutation.own_audit',
              resourceType: 'content',
              resourceId: input.targetId,
              result: 'success',
            });
            return { ok: true };
          }),
        failing: route
          .route({ method: 'POST', path: '/testing/admin-mutation/failing' })
          .input(MutationInput)
          .handler(async ({ context }) => {
            await adminGuard.assert(context, 'content', 'update');
            throw new ORPCError('CONFLICT', { message: 'conflict on purpose' });
          }),
        read: route
          .route({ method: 'GET', path: '/testing/admin-mutation/read' })
          .handler(async ({ context }) => {
            await adminGuard.assert(context, 'content', 'update');
            return { ok: true };
          }),
      };
    });
  },
} satisfies Plugin<CoreTokenCatalog>;

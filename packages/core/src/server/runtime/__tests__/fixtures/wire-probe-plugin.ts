import { ORPCError, os } from '@orpc/server';
import * as z from 'zod';
import type { TokenCatalog } from '@openora/core/contracts';
import type { Plugin } from '../../../plugin-host/define-plugin.js';
import { wireErrorResponse } from '../../../kernel/wire-error-response.js';

const probe = {
  wire400: os.route({ method: 'POST', path: '/wire-probe/400' }).handler(() => {
    throw wireErrorResponse(400, { error: 'refused', detail: 'Over the limit' });
  }),
  wire500: os.route({ method: 'POST', path: '/wire-probe/500' }).handler(() => {
    throw wireErrorResponse(500, { error: 'retry' });
  }),
  wire500Cause: os.route({ method: 'POST', path: '/wire-probe/500-cause' }).handler(() => {
    throw wireErrorResponse(500, { error: 'retry' }, { cause: new Error('ledger unavailable') });
  }),
  notFound: os.route({ method: 'POST', path: '/wire-probe/not-found' }).handler(() => {
    throw new ORPCError('NOT_FOUND', { message: 'No such bet' });
  }),
  invalid: os
    .route({ method: 'POST', path: '/wire-probe/invalid' })
    .input(z.object({ amount: z.number() }))
    .handler(() => ({ ok: true })),
  crash: os.route({ method: 'POST', path: '/wire-probe/crash' }).handler(() => {
    throw new Error('database went away');
  }),
};

export default {
  id: 'wire-probe',
  register(ctx) {
    ctx.routers.add('wireProbe', () => probe);
  },
} satisfies Plugin<TokenCatalog>;

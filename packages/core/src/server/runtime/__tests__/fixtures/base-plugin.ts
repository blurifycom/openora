import * as z from 'zod';
import { queue, type TokenCatalog } from '@openora/core/contracts';
import type { Plugin } from '../../../plugin-host/define-plugin.js';

export default {
  id: 'fixture-base',
  register(ctx) {
    for (const name of ['fixture-base.daily', 'fixture-base.weekly']) {
      ctx.jobs.worker({ queue: queue(name), schema: z.object({}), handler: async () => {} });
    }
  },
} satisfies Plugin<TokenCatalog>;

import * as z from 'zod';
import { queue, type TokenCatalog } from '@openora/core/contracts';
import type { Plugin } from '../../../plugin-host/define-plugin.js';

export default {
  id: 'fixture-late-worker',
  register(ctx) {
    ctx.routers.add('fixture-late-worker', () => {
      ctx.jobs.worker({
        queue: queue('fixture-late-worker.run'),
        schema: z.object({}),
        handler: async () => {},
      });
      return {};
    });
  },
} satisfies Plugin<TokenCatalog>;

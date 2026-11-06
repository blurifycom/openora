import * as z from 'zod';
import { queue, type TokenCatalog } from '@openora/core/contracts';
import type { Plugin } from '../../../plugin-host/define-plugin.js';

export default {
  id: 'fixture-feature',
  dependsOn: ['fixture-base'],
  register(ctx) {
    ctx.jobs.worker({
      queue: queue('fixture-feature.sync'),
      schema: z.object({}),
      handler: async () => {},
    });
  },
} satisfies Plugin<TokenCatalog>;

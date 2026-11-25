import * as z from 'zod';
import { createToken, queue, type TokenCatalog } from '@openora/core/contracts';
import type { Plugin } from '../../define-plugin.js';

export const PORTED = createToken<string>('ported');
export const built: string[] = [];

export default {
  id: 'ported',
  register(ctx) {
    ctx.provide(PORTED, () => 'bound');
    ctx.events.on('ported.happened', () => {});
    ctx.jobs.worker({ queue: queue('ported-job'), schema: z.object({}), handler: async () => {} });
    ctx.routers.add('ported', () => {
      built.push('ported');
      return { route: 'real' };
    });
  },
} as const satisfies Plugin<TokenCatalog>;

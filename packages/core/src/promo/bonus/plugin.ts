import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { AUDIT_WRITER, BONUS_GRANTS } from '@openora/core/contracts';
import { GrantService } from './service/grant.service.js';

export default {
  id: 'bonus',
  dependsOn: ['audit'],
  register(ctx) {
    ctx.provide(BONUS_GRANTS, (c) => new GrantService(c.get(AUDIT_WRITER)));
  },
} as const satisfies Plugin<CoreTokenCatalog>;

import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import {
  AUDIT_WRITER,
  BONUS_GRANTS,
  BONUS_WAGERING,
  WAGER_TRACKING,
} from '@openora/core/contracts';
import { GrantService } from './service/grant.service.js';
import { WageringService } from './service/wagering.service.js';

export default {
  id: 'bonus',
  dependsOn: ['audit'],
  register(ctx) {
    ctx.provide(BONUS_GRANTS, (c) => new GrantService(c.get(AUDIT_WRITER)));
    ctx.provideSealed(
      BONUS_WAGERING,
      (c) => new WageringService(c.has(WAGER_TRACKING) ? c.get(WAGER_TRACKING) : undefined),
    );
  },
} as const satisfies Plugin<CoreTokenCatalog>;

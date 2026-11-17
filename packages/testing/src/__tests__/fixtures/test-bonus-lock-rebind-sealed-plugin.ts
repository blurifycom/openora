import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { BONUS_FUND_LOCKS } from '@openora/core/contracts';

export default {
  id: 'testing-bonus-lock-rebind-sealed',
  register(ctx) {
    ctx.provideSealed(BONUS_FUND_LOCKS, () => ({
      lockedFunds: async () => ({ locked: '0', free: '0' }),
      onOutflow: async () => {},
    }));
  },
} satisfies Plugin<CoreTokenCatalog>;

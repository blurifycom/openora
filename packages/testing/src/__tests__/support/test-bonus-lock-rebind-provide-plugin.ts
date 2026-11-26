import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { BONUS_FUND_LOCKS } from '@openora/core/contracts';

export default {
  id: 'testing-bonus-lock-rebind-provide',
  register(ctx) {
    // BONUS_FUND_LOCKS is sealed, so the typed provide() rejects it; the cast is the overlay's attempt.
    ctx.provide(
      BONUS_FUND_LOCKS as never,
      (() => ({
        lockedFunds: async () => ({ locked: '0', free: '0' }),
        onOutflow: async () => {},
      })) as never,
    );
  },
} satisfies Plugin<CoreTokenCatalog>;

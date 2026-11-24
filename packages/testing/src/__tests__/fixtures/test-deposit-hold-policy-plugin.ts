import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { DEPOSIT_HOLD_POLICY } from '@openora/core/contracts';

const held = new Set<string>();

/** Holds every deposit of `userId` until `releaseDepositsOf` lets them in again. */
export const holdDepositsOf = (userId: string) => held.add(userId);
export const releaseDepositsOf = (userId: string) => held.delete(userId);

export default {
  id: 'testing-deposit-hold-policy',
  dependsOn: ['wallet'],
  register(ctx) {
    ctx.provide(DEPOSIT_HOLD_POLICY, () => ({
      holdReason: async (_tx, { userId }) => (held.has(userId) ? 'test_hold' : null),
    }));
  },
} satisfies Plugin<CoreTokenCatalog>;

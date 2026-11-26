import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { DEPOSIT_HOLD_POLICY } from '@openora/core/contracts';

const BARRED_STORE = Symbol.for('openora.testing.barred-depositors');
const holder = globalThis as typeof globalThis & { [BARRED_STORE]?: Set<string> };
const barred = (holder[BARRED_STORE] ??= new Set<string>());

export const BARRED_HOLD_REASON = 'barred_from_depositing';

export const barFromDepositing = (userId: string) => {
  barred.add(userId);
};

export const allowDepositing = (userId: string) => {
  barred.delete(userId);
};

export default {
  id: 'testing-deposit-hold',
  dependsOn: ['wallet'],
  register(ctx) {
    ctx.provide(DEPOSIT_HOLD_POLICY, () => ({
      async holdReason(_tx, { userId }) {
        return barred.has(userId) ? BARRED_HOLD_REASON : null;
      },
    }));
  },
} satisfies Plugin<CoreTokenCatalog>;

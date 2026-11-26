import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { DEPOSIT_ADMISSION_POLICY } from '@openora/core/contracts';
import { globalStore } from './global-store.js';

const REFUSED_STORE = Symbol.for('openora.testing.deposit-admission-refused');
const isIdSet = (value: unknown): value is Set<string> => value instanceof Set;
const refused = globalStore(REFUSED_STORE, isIdSet, () => new Set<string>());

export const ADMISSION_REFUSAL_REASON = 'kyc_required';

export const refuseDepositAdmission = (userId: string) => {
  refused.add(userId);
};

export default {
  id: 'testing-deposit-admission',
  dependsOn: ['wallet'],
  register(ctx) {
    ctx.provide(DEPOSIT_ADMISSION_POLICY, () => ({
      async refusalReason(userId) {
        return refused.has(userId) ? ADMISSION_REFUSAL_REASON : null;
      },
    }));
  },
} satisfies Plugin<CoreTokenCatalog>;

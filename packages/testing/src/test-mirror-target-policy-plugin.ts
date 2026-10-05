import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { MIRROR_TARGET_POLICY } from '@openora/core/contracts';

/** Approves one mirror origin, so an e2e can drive both an approved and a refused target. */
export const APPROVED_MIRROR_ORIGIN = 'https://mirror.e2e.test';

export default {
  id: 'testing-mirror-target-policy',
  dependsOn: ['compliance'],
  register(ctx) {
    ctx.provide(MIRROR_TARGET_POLICY, () => ({
      isApprovedTarget: async (_tx: unknown, origin: string) => origin === APPROVED_MIRROR_ORIGIN,
    }));
  },
} satisfies Plugin<CoreTokenCatalog>;

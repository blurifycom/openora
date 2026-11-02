import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { SPORTSBOOK_PROVIDER, type SportsbookProvider } from '@openora/core/contracts';

/** A provider with no bet status API: core can issue sessions but never ask what a bet became. */
export const sportsbookProviderWithoutStatus: SportsbookProvider = {
  name: 'test-provider',
  async issueSession(args) {
    return { token: `token-${args.sessionId}`, launchUrl: 'https://provider.test/launch' };
  },
  async revokeSession() {},
};

export default {
  id: 'testing-sportsbook-provider-without-status',
  dependsOn: ['betting'],
  register(ctx) {
    ctx.provide(SPORTSBOOK_PROVIDER, () => sportsbookProviderWithoutStatus);
  },
} satisfies Plugin<CoreTokenCatalog>;

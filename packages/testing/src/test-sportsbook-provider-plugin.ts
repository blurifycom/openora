import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import {
  SPORTSBOOK_PROVIDER,
  type SportsbookProvider,
  type SportsbookProviderBetStatus,
  type SportsbookProviderSessionArgs,
} from '@openora/core/contracts';

/**
 * A scripted SPORTSBOOK_PROVIDER for tests only: a test sets what the provider reports for a bet
 * and reads which sessions core issued and revoked. Opt-in; core ships no provider binding.
 */
export const mockSportsbookProviderState = {
  statuses: new Map<string, SportsbookProviderBetStatus>(),
  issued: [] as SportsbookProviderSessionArgs[],
  revoked: [] as string[],
  lookups: [] as string[],
  failIssue: false,
  failLookup: false,
  /** How many of the next session revokes fail. */
  failRevokes: 0,
  onIssue: null as ((args: SportsbookProviderSessionArgs) => Promise<void>) | null,
  onLookup: null as ((providerBetId: string) => Promise<void>) | null,
  reset() {
    mockSportsbookProviderState.statuses.clear();
    mockSportsbookProviderState.issued.length = 0;
    mockSportsbookProviderState.revoked.length = 0;
    mockSportsbookProviderState.lookups.length = 0;
    mockSportsbookProviderState.failIssue = false;
    mockSportsbookProviderState.failLookup = false;
    mockSportsbookProviderState.failRevokes = 0;
    mockSportsbookProviderState.onIssue = null;
    mockSportsbookProviderState.onLookup = null;
  },
};

const state = mockSportsbookProviderState;

export const mockSportsbookProvider: SportsbookProvider = {
  name: 'test-provider',
  async issueSession(args) {
    if (state.failIssue) {
      throw new Error('provider unavailable');
    }
    await state.onIssue?.(args);
    state.issued.push(args);
    return { token: `token-${args.sessionId}`, launchUrl: 'https://provider.test/launch' };
  },
  async revokeSession({ sessionId }) {
    if (state.failRevokes > 0) {
      state.failRevokes -= 1;
      throw new Error('provider unavailable');
    }
    state.revoked.push(sessionId);
  },
  async getBetStatus({ providerBetId }) {
    state.lookups.push(providerBetId);
    await state.onLookup?.(providerBetId);
    if (state.failLookup) {
      throw new Error('provider unavailable');
    }
    return state.statuses.get(providerBetId) ?? { status: 'not_found' };
  },
};

export default {
  id: 'testing-sportsbook-provider',
  dependsOn: ['betting'],
  register(ctx) {
    ctx.provide(SPORTSBOOK_PROVIDER, () => mockSportsbookProvider);
  },
} satisfies Plugin<CoreTokenCatalog>;

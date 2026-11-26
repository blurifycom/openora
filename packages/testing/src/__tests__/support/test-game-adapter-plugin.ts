import { randomUUID } from 'node:crypto';
import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { GAME_ADAPTER, type GameAdapter } from '@openora/core/contracts';
import { globalStore } from './global-store.js';

type AdapterScript = {
  launchFailsFor: Set<string>;
  payoutByRound: Map<string, string>;
  launches: string[];
  endCalls: string[];
};

const SCRIPT_STORE = Symbol.for('openora.testing.game-adapter-script');
const isScript = (value: unknown): value is AdapterScript =>
  typeof value === 'object' && value !== null && 'payoutByRound' in value;
const script = globalStore(
  SCRIPT_STORE,
  isScript,
  (): AdapterScript => ({
    launchFailsFor: new Set(),
    payoutByRound: new Map(),
    launches: [],
    endCalls: [],
  }),
);

export const failLaunchOf = (gameId: string) => {
  script.launchFailsFor.add(gameId);
};

export const reportPayoutFor = (roundId: string, winAmount: string) => {
  script.payoutByRound.set(roundId, winAmount);
};

export const launchesOf = (gameId: string) => script.launches.filter((id) => id === gameId);

export const endCallsFor = (roundId: string) => script.endCalls.filter((id) => id === roundId);

export const LAUNCH_FAILURE = 'provider launch refused';

export default {
  id: 'testing-game-adapter',
  dependsOn: ['gaming'],
  register(ctx) {
    ctx.provide(
      GAME_ADAPTER,
      () =>
        ({
          async launchGame(gameId, userId, currency) {
            script.launches.push(gameId);
            if (script.launchFailsFor.has(gameId)) {
              throw new Error(LAUNCH_FAILURE);
            }
            const token = `test-token-${randomUUID()}`;
            return {
              launchUrl: `https://games.example.test/play?gameId=${gameId}&currency=${currency}&user=${userId}&token=${token}`,
              token,
            };
          },
          async endRound(externalRoundId) {
            script.endCalls.push(externalRoundId);
            const winAmount = script.payoutByRound.get(externalRoundId);
            return winAmount === undefined ? {} : { winAmount };
          },
        }) satisfies GameAdapter,
    );
  },
} satisfies Plugin<CoreTokenCatalog>;

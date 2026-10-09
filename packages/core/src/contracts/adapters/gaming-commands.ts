/**
 * Gaming command port: a wallet bridge accumulates a provider-reported round delta on the
 * caller's own `tx`, atomic with whatever wallet move the caller makes in the same
 * transaction. Mirrors the WALLET_COMMANDS command-port idiom (ADR-0017).
 */
import { createToken, type Token } from './token.js';

export type GamingAccumulateExternalRoundArgs = {
  gameId: string;
  userId: string;
  currency: string;
  externalRoundId: string;
  betDelta?: string;
  winDelta?: string;
  isFinal?: boolean;
};

export type GamingAccumulateExternalRoundOutcome = {
  roundId: string;
  betAmount: string;
  winAmount: string;
};

export type GamingSetGameAvailabilityArgs = {
  gameId: string;
  isUnavailable: boolean;
};

export type GamingNotifyGamesCreatedArgs = {
  gameIds: readonly string[];
};

export type GamingNotifyGamesChangedArgs = {
  gameIds: readonly string[];
  /** Tags the games were linked to before the change, so rules naming a removed tag re-evaluate. */
  tagIds?: readonly string[];
  /** Providers the games belonged to before the change. */
  providerIds?: readonly string[];
};

export type GamingCommands = {
  accumulateExternalRound(
    tx: unknown,
    args: GamingAccumulateExternalRoundArgs,
  ): Promise<GamingAccumulateExternalRoundOutcome>;
  /**
   * The only writer of a game's vendor-unavailable flag; an unavailable game is unplayable.
   * `changed` is false when the game was already in that state. Throws when the game is unknown.
   */
  setGameAvailability(args: GamingSetGameAvailabilityArgs): Promise<{ changed: boolean }>;
  /**
   * Reports game rows the caller has already inserted and committed (a catalogue sync, a
   * seed). Emits `gaming.games.created` so rule-mode categories re-evaluate at once;
   * unknown ids are dropped. A caller that skips this is still covered by the periodic
   * membership sweep. Optional so an overlay that rebound this port before the method
   * existed keeps type-checking; core's own binding always provides it.
   */
  notifyGamesCreated?(args: GamingNotifyGamesCreatedArgs): Promise<void>;
  /**
   * Reports existing game rows the caller has already rewritten and committed outside the
   * admin update (a catalogue sync changing names, providers, tags). Marks their categories
   * for re-ranking and emits `gaming.games.changed` so rule-mode categories re-evaluate at
   * once; unknown ids are dropped. Report only games that really changed: each one re-ranks
   * every category it is in. Optional for the same reason as `notifyGamesCreated`.
   */
  notifyGamesChanged?(args: GamingNotifyGamesChangedArgs): Promise<void>;
};

export const GAMING_COMMANDS: Token<GamingCommands> = createToken('GAMING_COMMANDS');

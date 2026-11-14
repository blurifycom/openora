/**
 * Gaming command port: a wallet bridge accumulates a provider-reported round delta on the
 * caller's own `tx`, atomic with whatever wallet move the caller makes in the same
 * transaction. Mirrors the WALLET_COMMANDS command-port idiom (ADR-0017).
 */
import type { DomainEventPayload } from '../schemas/events.js';
import { createToken, type Token } from './token.js';
import type { WagerProduct } from './wager-context.js';

/**
 * The wagering inputs a round is priced under, snapshotted on the round row the first time it is
 * seen and never changed after, so a later catalogue edit cannot reprice a placed or settled round.
 * Null when neither the caller nor the catalogue named it.
 */
export type GamingRoundWager = {
  product: WagerProduct | null;
  /** Decimal fraction in [0, 1], as `WagerContext.rtp`. */
  rtp: string | null;
};

export type GamingAccumulateExternalRoundArgs = {
  gameId: string;
  userId: string;
  currency: string;
  externalRoundId: string;
  /** Negative reverses stake already counted; the round keeps it as `reversedAmount`, also once it has ended. */
  betDelta?: string;
  winDelta?: string;
  isFinal?: boolean;
  /**
   * What the caller knows of the variant played (an aggregator's per-session rtp). Fills a round
   * snapshot field the round does not hold yet only where the catalogue's `ledger_game` has none;
   * a value that differs from the catalogue's is logged and dropped.
   */
  wager?: Partial<GamingRoundWager>;
  /**
   * Lands only on an existing round of this game, player and currency that holds at least the
   * stake a negative `betDelta` reverses; anything else throws GamingRoundOwnerMismatchError and
   * writes nothing. For a reversal on a round the caller named rather than one the ledger derived.
   */
  existingRoundOnly?: boolean;
};

export type GamingAccumulateExternalRoundOutcome = {
  roundId: string;
  betAmount: string;
  winAmount: string;
  /** The round's snapshot once this call landed: what every stake on it is priced under. */
  wager: GamingRoundWager;
  /** True only for the call that moved the round to completed; a repeated final is false. */
  ended: boolean;
};

export type GamingSetGameAvailabilityArgs = {
  gameId: string;
  isUnavailable: boolean;
};

export type GamingSetGameAvailabilityOutcome =
  | { changed: true; event: DomainEventPayload<'gaming.game.availability_changed'> }
  | { changed: false };

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

/**
 * A stake would open a new round on a game the ledger has no `ledger_game` row for: the catalogue
 * never reported it, or the projection has not caught up. Only that stake is refused; a call with
 * no stake (a win, a refund, a rollback, a final) never is, even as a round's first call (a
 * free-round result, a settle that arrives before its bet), and neither is a stake on a round that
 * already exists. Thrown before any round row or money moves, so the caller's transaction rolls
 * back whole. A provider bridge answers it with a final, non-retry "unknown game" code that
 * refuses the bet.
 */
export class GamingUnknownGameError extends Error {
  readonly gameId: string;
  constructor(gameId: string) {
    super(`game ${gameId} is unknown to the round ledger`);
    this.name = 'GamingUnknownGameError';
    this.gameId = gameId;
  }
}

/**
 * The `externalRoundId` is already a round of another game, player or currency. Nothing was
 * written: the caller's transaction rolls back whole.
 */
export class GamingRoundOwnerMismatchError extends Error {
  readonly externalRoundId: string;
  constructor(externalRoundId: string) {
    super(`externalRoundId ${externalRoundId} is already tagged to a different game/user`);
    this.name = 'GamingRoundOwnerMismatchError';
    this.externalRoundId = externalRoundId;
  }
}

/**
 * The caller's `wager.rtp` is not a decimal fraction in [0, 1]. Thrown before anything is
 * written, whether or not the catalogue's rtp would have won.
 */
export class GamingInvalidRtpError extends Error {
  readonly rtp: string;
  constructor(rtp: string) {
    super(`rtp ${rtp} is not a decimal fraction in [0, 1]`);
    this.name = 'GamingInvalidRtpError';
    this.rtp = rtp;
  }
}

export type GamingCommands = {
  /**
   * Throws GamingUnknownGameError, before writing anything, when the call carries a positive
   * `betDelta`, no round with this `externalRoundId` exists yet, and `ledger_game` lacks the
   * game. A call with no stake, or on an existing round, is never refused for its game.
   * Throws GamingRoundOwnerMismatchError when the round belongs to another game or player.
   * Throws GamingInvalidRtpError, before writing anything, on an out-of-range `wager.rtp`.
   */
  accumulateExternalRound(
    tx: unknown,
    args: GamingAccumulateExternalRoundArgs,
  ): Promise<GamingAccumulateExternalRoundOutcome>;
  /**
   * With `setGameAvailabilityInTransaction`, the only writer of a game's vendor-unavailable
   * flag; an unavailable game is unplayable. Runs in its own transaction and emits after it.
   * `changed` is false when the game was already in that state. Throws when the game is unknown.
   */
  setGameAvailability(args: GamingSetGameAvailabilityArgs): Promise<{ changed: boolean }>;
  /**
   * `setGameAvailability` on the caller's own `tx`, so the flag flips atomically with the
   * caller's writes. It never emits: on `changed: true` the caller emits
   * `gaming.game.availability_changed` with `event` once its transaction commits; the event
   * queues the re-rank and is the core audit record of the flip.
   * The game row stays locked until the caller commits, so flip one game per transaction and
   * keep it short. Throws when the game is unknown. Optional on the type for the same reason
   * as `notifyGamesCreated`, but a caller must fail when it is absent rather than skip the flip.
   */
  setGameAvailabilityInTransaction?(
    tx: unknown,
    args: GamingSetGameAvailabilityArgs,
  ): Promise<GamingSetGameAvailabilityOutcome>;
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

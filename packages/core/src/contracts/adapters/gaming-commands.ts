import type { DomainEventPayload } from '../schemas/events.js';
import { createToken, type Token } from './token.js';
import type { WagerProduct } from './wager-context.js';

export type GamingRoundWager = {
  product: WagerProduct | null;
  rtp: string | null;
};

export type GamingAccumulateExternalRoundArgs = {
  gameId: string;
  userId: string;
  currency: string;
  externalRoundId: string;
  betDelta?: string;
  winDelta?: string;
  isFinal?: boolean;
  wager?: Partial<GamingRoundWager>;
  existingRoundOnly?: boolean;
};

export type GamingAccumulateExternalRoundOutcome = {
  roundId: string;
  betAmount: string;
  winAmount: string;
  wager: GamingRoundWager;
  announce: boolean;
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
  tagIds?: readonly string[];
  providerIds?: readonly string[];
};

export class GamingUnknownGameError extends Error {
  readonly gameId: string;
  constructor(gameId: string) {
    super(`game ${gameId} is unknown to the round ledger`);
    this.name = 'GamingUnknownGameError';
    this.gameId = gameId;
  }
}

export class GamingRoundOwnerMismatchError extends Error {
  readonly externalRoundId: string;
  constructor(externalRoundId: string) {
    super(`externalRoundId ${externalRoundId} is already tagged to a different game/user`);
    this.name = 'GamingRoundOwnerMismatchError';
    this.externalRoundId = externalRoundId;
  }
}

export class GamingInvalidRtpError extends Error {
  readonly rtp: string;
  constructor(rtp: string) {
    super(`rtp ${rtp} is not a decimal fraction in [0, 1]`);
    this.name = 'GamingInvalidRtpError';
    this.rtp = rtp;
  }
}

export type GamingCommands = {
  accumulateExternalRound(
    tx: unknown,
    args: GamingAccumulateExternalRoundArgs,
  ): Promise<GamingAccumulateExternalRoundOutcome>;
  setGameAvailability(args: GamingSetGameAvailabilityArgs): Promise<{ changed: boolean }>;
  setGameAvailabilityInTransaction?(
    tx: unknown,
    args: GamingSetGameAvailabilityArgs,
  ): Promise<GamingSetGameAvailabilityOutcome>;
  notifyGamesCreated?(args: GamingNotifyGamesCreatedArgs): Promise<void>;
  notifyGamesChanged?(args: GamingNotifyGamesChangedArgs): Promise<void>;
};

export const GAMING_COMMANDS: Token<GamingCommands> = createToken('GAMING_COMMANDS');

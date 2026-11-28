import type { PlayEligibilitySnapshot } from '../schemas/ledger.js';
import type { PlayerStatus } from '../schemas/player.js';
import { createSealedToken, createToken, type SealedToken, type Token } from './token.js';

export type PlayEligibilityPort = {
  isRestricted(userId: string, tx?: unknown): Promise<boolean>;
  checkPlay?(userId: string, tx?: unknown): Promise<PlayRefusal | null>;
};

export const PLAY_REFUSALS = [
  'self_excluded',
  'cooling_off',
  'account_suspended',
  'account_closed',
  'account_inactive',
] as const;
export type PlayRefusal = (typeof PLAY_REFUSALS)[number];

export type PlayEligibilityState = {
  rgBlocked: boolean;
  rgBlockedUntil: Date | null;
  isActive: boolean;
  banned: boolean;
  banExpires: Date | null;
  status: PlayerStatus | null;
};

export function playRefusalOf(state: PlayEligibilityState, now = new Date()): PlayRefusal | null {
  if (state.rgBlocked && (state.rgBlockedUntil === null || state.rgBlockedUntil > now)) {
    return state.rgBlockedUntil === null ? 'self_excluded' : 'cooling_off';
  }
  switch (state.status) {
    case 'self_excluded':
      return 'self_excluded';
    case 'suspended':
      return 'account_suspended';
    case 'closed':
      return 'account_closed';
  }
  const banned = state.banned && (state.banExpires === null || state.banExpires > now);
  return !state.isActive || banned ? 'account_inactive' : null;
}

export async function isPlayRefused(
  port: PlayEligibilityPort,
  userId: string,
  tx?: unknown,
): Promise<boolean> {
  return port.checkPlay
    ? (await port.checkPlay(userId, tx)) !== null
    : port.isRestricted(userId, tx);
}

export const PLAY_ELIGIBILITY: Token<PlayEligibilityPort> =
  createToken<PlayEligibilityPort>('PLAY_ELIGIBILITY');

export type LedgerPlayEligibilityPort = Required<PlayEligibilityPort> & {
  stateOf(userId: string, tx?: unknown): Promise<PlayEligibilityState | null>;
  statesOf(userIds: readonly string[], tx?: unknown): Promise<Map<string, PlayEligibilityState>>;
};

export const LEDGER_PLAY_ELIGIBILITY: SealedToken<LedgerPlayEligibilityPort> =
  createSealedToken<LedgerPlayEligibilityPort>('LEDGER_PLAY_ELIGIBILITY');

export type PlayEligibilityProjectionPort = {
  write(snapshot: PlayEligibilitySnapshot, tx: unknown): Promise<void>;
  reconcile(snapshots: readonly PlayEligibilitySnapshot[]): Promise<number>;
  heartbeat(): Promise<void>;
  readonly remote?: boolean;
};

export const PLAY_ELIGIBILITY_PROJECTION: SealedToken<PlayEligibilityProjectionPort> =
  createSealedToken<PlayEligibilityProjectionPort>('PLAY_ELIGIBILITY_PROJECTION');

export type PlayEligibilitySourcePort = {
  page(afterUserId: string | null, limit: number): Promise<PlayEligibilitySnapshot[]>;
  snapshots(userIds: readonly string[]): Promise<PlayEligibilitySnapshot[]>;
  repair(userIds: readonly string[]): Promise<string[]>;
};

export const PLAY_ELIGIBILITY_SOURCE: SealedToken<PlayEligibilitySourcePort> =
  createSealedToken<PlayEligibilitySourcePort>('PLAY_ELIGIBILITY_SOURCE');

export const LEDGER_PROJECTIONS = ['play_eligibility', 'rg_limits'] as const;
export type LedgerProjection = (typeof LEDGER_PROJECTIONS)[number];

export class LedgerProjectionStaleError extends Error {
  readonly code = 'ledger_projection_stale';
  constructor(
    readonly projection: LedgerProjection,
    readonly lastBeatAt: Date | null,
  ) {
    super(
      `the ledger's ${projection} projection is stale (last heartbeat ${lastBeatAt?.toISOString() ?? 'never'}); refused`,
    );
    this.name = 'LedgerProjectionStaleError';
  }
}

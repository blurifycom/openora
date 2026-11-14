import type { PlayEligibilitySnapshot } from '../schemas/ledger.js';
import type { PlayerStatus } from '../schemas/player.js';
import { createSealedToken, createToken, type SealedToken, type Token } from './token.js';

/**
 * Read port for Responsible-Gambling play enforcement. Owned + bound by the identity
 * module (it owns the `user` table and the `rgBlocked`/`rgBlockedUntil` projection that
 * `LOGIN_ENFORCEMENT` writes). Gaming and wallet depend only on this port to refuse a
 * wager, never on the identity schema.
 *
 * A cooling-off whose `rgBlockedUntil` has elapsed reports `false` without waiting for
 * the expiry sweep, matching the login gate's lazy-expiry behaviour.
 *
 * A caller already inside a transaction passes it as `tx`: a second pool connection taken
 * while the first is held deadlocks once every connection is held by such a caller. The
 * read then holds the player's row `FOR SHARE` until that transaction ends, so a
 * restriction landing concurrently waits for it instead of committing between the check
 * and the money movement it gates.
 */
export type PlayEligibilityPort = {
  isRestricted(userId: string, tx?: unknown): Promise<boolean>;
  /**
   * Why the player may not play now, on top of the RG block `isRestricted` reports: the account's
   * own state too. `null` lets them play. Same `tx` rule as `isRestricted`. Optional: a caller
   * without it falls back to `isRestricted` and cannot name the reason.
   */
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

/**
 * The account facts a play decision reads: the identity `user` row and the player profile's
 * `status` (null for a user without one yet, which plays like `active`).
 */
export type PlayEligibilityState = {
  rgBlocked: boolean;
  rgBlockedUntil: Date | null;
  isActive: boolean;
  banned: boolean;
  banExpires: Date | null;
  status: PlayerStatus | null;
};

/**
 * Why `state` may not play at `now`, or null. The one decision both the identity read and the
 * ledger's projection make, so they cannot drift. A cooling-off or ban whose end has passed no
 * longer refuses, without waiting for a sweep to clear it.
 */
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

/** True when the player may not wager or deposit: `checkPlay` when bound, else `isRestricted`. */
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

/**
 * The ledger's own answer for a stake, from the `ledger_play_eligibility` projection the wallet
 * module keeps, never the identity tables. Bound by wallet; only the money paths that take a
 * stake read it. A user the projection has no row for is refused `account_inactive`. Sealed: an
 * overlay can neither rebind the stake gate nor the writer that lifts a restriction.
 */
export const LEDGER_PLAY_ELIGIBILITY: SealedToken<Required<PlayEligibilityPort>> =
  createSealedToken<Required<PlayEligibilityPort>>('LEDGER_PLAY_ELIGIBILITY');

/**
 * Writes to the ledger's `ledger_play_eligibility` projection. Wallet-internal: bound by wallet,
 * called only by identity, the owner of every input. Not part of the Ledger API a provider
 * bridge sees. See ADR-0054.
 */
export type PlayEligibilityProjectionPort = {
  /**
   * The authoritative write, on the writer's `tx` under its user row lock, so the projection
   * commits or rolls back with the change it reflects. A stored row at a higher version than
   * `snapshot` is overwritten and logged as an error: only a foreign writer can have put it there.
   */
  write(snapshot: PlayEligibilitySnapshot, tx: unknown): Promise<void>;
  /**
   * The repair path (outbox redelivery, backfill): keeps the newest version, writes only the rows
   * that are missing, older, or at the same version but different, and returns how many it wrote.
   */
  reconcile(snapshots: readonly PlayEligibilitySnapshot[]): Promise<number>;
};

export const PLAY_ELIGIBILITY_PROJECTION: SealedToken<PlayEligibilityProjectionPort> =
  createSealedToken<PlayEligibilityProjectionPort>('PLAY_ELIGIBILITY_PROJECTION');

/**
 * Identity's committed play eligibility, read for the wallet's reconciliation to compare its
 * projection against. Bound by identity, the owner of every input. Sealed: rebinding it could
 * hide a projection that lets an excluded player stake.
 */
export type PlayEligibilitySourcePort = {
  /** Up to `limit` users' snapshots in user id order, after `afterUserId` when given. */
  page(afterUserId: string | null, limit: number): Promise<PlayEligibilitySnapshot[]>;
  /** The committed snapshots of `userIds`, read now; an unknown user is left out. */
  snapshots(userIds: readonly string[]): Promise<PlayEligibilitySnapshot[]>;
  /** Re-publishes each of `userIds` through identity's own writer, under a new version. */
  repair(userIds: readonly string[]): Promise<void>;
};

export const PLAY_ELIGIBILITY_SOURCE: SealedToken<PlayEligibilitySourcePort> =
  createSealedToken<PlayEligibilitySourcePort>('PLAY_ELIGIBILITY_SOURCE');

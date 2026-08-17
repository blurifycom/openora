import { createToken, type Token } from './token.js';

/**
 * Best-effort "player is active right now" tracker, bound by the module that owns
 * the `player` table's writes (see PLAYER_ACTIVITY_TRACKER's binder). The per-request
 * auth middleware calls this fire-and-forget for every authenticated request -
 * implementations must stay cheap (a throttled/guarded write, never an unconditional
 * one) since it runs on the hot path. Consumers (eg the Friends tab's online/offline
 * status) read the result back via `player.lastSeenAt`, not through this port.
 */
export type PlayerActivityTracker = {
  touchLastSeen(userId: string): Promise<void>;
};

export const PLAYER_ACTIVITY_TRACKER: Token<PlayerActivityTracker> =
  createToken('PLAYER_ACTIVITY_TRACKER');

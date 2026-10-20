/**
 * Read-only view of the players an automated run may target, for code outside the player
 * modules (an agent run started for a segment, or for the player a domain event is about), so
 * it never re-implements who counts as a player. The population is every account with the
 * `player` role that is not deactivated (`isActive` false, the back office's ban) and has a
 * player profile whose status is not `closed`. Suspended and self-excluded players stay in it,
 * because a check may need to look at them, and whatever may not be done to them is refused
 * where it would be done. Ids are player ids (`player.id`), the ones agent tools take.
 */
import { createToken, type Token } from './token.js';
import type { Player } from '../schemas/player.js';
import type { TagKey } from '../schemas/tag.js';

export const MAX_PLAYER_SEGMENT_PAGE = 1000;

export type PlayerSegmentQuery = {
  /**
   * Only players holding at least one of these tags; omit it for every player. An empty list
   * or a key that is not a tag key throws a `RangeError`.
   */
  tags?: readonly TagKey[];
  /** The `next` of the previous page. */
  after?: Player['id'];
  /** 1 to `MAX_PLAYER_SEGMENT_PAGE`. */
  limit: number;
};

export type PlayerSegmentPage = {
  /** Ascending. */
  playerIds: Player['id'][];
  /** Pass as `after` for the next page; null when this was the last one. */
  next: Player['id'] | null;
};

export type PlayerSegmentReader = {
  page(query: PlayerSegmentQuery): Promise<PlayerSegmentPage>;
  /**
   * The given players that are in the population, keyed by the id passed in, at most
   * `MAX_PLAYER_SEGMENT_PAGE` ids. A user id resolves to that user's player id. An id that is
   * unknown, not a player's, closed or not a UUID is absent.
   */
  resolve(
    ref: { playerIds: readonly string[] } | { userIds: readonly string[] },
  ): Promise<Map<string, Player['id']>>;
};

export const PLAYER_SEGMENT_READER: Token<PlayerSegmentReader> =
  createToken('PLAYER_SEGMENT_READER');

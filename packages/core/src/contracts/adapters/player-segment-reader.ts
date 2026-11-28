import { createToken, type Token } from './token.js';
import type { Player } from '../schemas/player.js';
import type { TagKey } from '../schemas/tag.js';

export const MAX_PLAYER_SEGMENT_PAGE = 1000;

export const MAX_PLAYER_SEGMENT_TAGS = 100;

export type PlayerSegmentQuery = {
  tags?: readonly TagKey[];
  after?: Player['id'];
  limit: number;
};

export type PlayerSegmentPage = {
  playerIds: Player['id'][];
  next: Player['id'] | null;
};

export type PlayerSegmentTag = {
  tag: TagKey;
  name: string;
  playerCount: number;
};

export type PlayerSegmentReader = {
  page(query: PlayerSegmentQuery): Promise<PlayerSegmentPage>;
  resolve(
    ref: { playerIds: readonly string[] } | { userIds: readonly string[] },
  ): Promise<Map<string, Player['id']>>;
  describe(tags: readonly string[]): Promise<PlayerSegmentTag[]>;
};

export const PLAYER_SEGMENT_READER: Token<PlayerSegmentReader> =
  createToken('PLAYER_SEGMENT_READER');

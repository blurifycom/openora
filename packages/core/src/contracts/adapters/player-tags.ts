import { createToken, type Token } from './token.js';
import type { TagKey } from '../schemas/tag.js';

// Read-only seam letting the wallet auto-withdrawal evaluator query a player's tags
// without importing the tag module's schema (module isolation). Absent from the map == no active tags.
export type PlayerTags = {
  getActiveTagKeys(userIds: readonly string[]): Promise<Map<string, TagKey[]>>;
};

export const PLAYER_TAGS: Token<PlayerTags> = createToken('PLAYER_TAGS');

import { createToken, type Token } from './token.js';
import type { TagKey } from '../schemas/tag.js';

export type PlayerTags = {
  getActiveTagKeys(userIds: readonly string[], tx?: unknown): Promise<Map<string, TagKey[]>>;
};

export const PLAYER_TAGS: Token<PlayerTags> = createToken('PLAYER_TAGS');

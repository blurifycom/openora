import * as z from 'zod';
import { GameSortKeySchema, type GameSortDirection, type GameSortKey } from '../schemas/game.js';
import { createToken, type Token } from './token.js';

const RefreshIntervalMsSchema = z
  .number()
  .int()
  .min(60_000)
  .max(365 * 24 * 60 * 60 * 1000)
  .optional();

export type GameSortRankInput<Params = unknown> = {
  categoryId: string;
  gameIds: string[];
  direction: GameSortDirection;
  params: Params;
};

export type GameSortDefinition<Params = unknown> = {
  key: GameSortKey;
  directions: readonly [GameSortDirection, ...GameSortDirection[]];
  paramsSchema: z.ZodType<Params>;
  refreshIntervalMs?: number;
  rank(input: GameSortRankInput<Params>): Promise<string[]>;
};

export type GameSortCatalog = {
  get(key: string): GameSortDefinition | undefined;
  list(): GameSortDefinition[];
};

export function defineGameSort<Params>(definition: {
  key: string;
  directions: readonly [GameSortDirection, ...GameSortDirection[]];
  paramsSchema: z.ZodType<Params>;
  refreshIntervalMs?: number;
  rank(input: GameSortRankInput<Params>): Promise<string[]>;
}): GameSortDefinition<Params> {
  return {
    key: GameSortKeySchema.parse(definition.key),
    directions: definition.directions,
    paramsSchema: definition.paramsSchema,
    refreshIntervalMs: RefreshIntervalMsSchema.parse(definition.refreshIntervalMs),
    rank: definition.rank,
  };
}

export function createGameSortCatalog(definitions: readonly GameSortDefinition[]): GameSortCatalog {
  const byKey = new Map<string, GameSortDefinition>();
  for (const definition of definitions) {
    if (byKey.has(definition.key)) {
      throw new Error(`Duplicate game sort definition: ${definition.key}`);
    }
    RefreshIntervalMsSchema.parse(definition.refreshIntervalMs);
    byKey.set(definition.key, definition);
  }
  return {
    get: (key) => byKey.get(key),
    list: () => [...byKey.values()],
  };
}

export const GAME_SORT_CATALOG: Token<GameSortCatalog> =
  createToken<GameSortCatalog>('GAME_SORT_CATALOG');

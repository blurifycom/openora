/**
 * Operator-extensible catalog of per-category game sorts. A definition's `rank()` returns
 * ordered game ids from any source it likes - the seam takes no Drizzle dependency, so it
 * belongs in contracts. A background job (owned by the gaming module) is the only writer
 * of the materialized `rank` a definition produces; nothing computes a category's order at
 * request time. Ships two built-ins ('manual', 'name'); an overlay rebinds GAME_SORT_CATALOG
 * to add or remove definitions - it is a plain (non-sealed) token.
 */
import * as z from 'zod';
import { GameSortKeySchema, type GameSortDirection, type GameSortKey } from '../schemas/game.js';
import { createToken, type Token } from './token.js';

// The rank sweep runs once a minute, so a shorter interval would silently act as one minute.
// The upper bound keeps the value inside a Postgres interval.
const RefreshIntervalMsSchema = z
  .number()
  .int()
  .min(60_000)
  .max(365 * 24 * 60 * 60 * 1000)
  .optional();

export type GameSortRankInput<Params = unknown> = {
  categoryId: string;
  /** Every current member of the category, including inactive games. */
  gameIds: string[];
  direction: GameSortDirection;
  params: Params;
};

export type GameSortDefinition<Params = unknown> = {
  key: GameSortKey;
  /** First entry is the default direction when a category sets this key without one. */
  directions: readonly [GameSortDirection, ...GameSortDirection[]];
  /** A real Zod schema (not a duck-typed parser) so the admin route can emit its JSON Schema. */
  paramsSchema: z.ZodType<Params>;
  /**
   * Rank age after which the sweep re-ranks - for data no catalogue event covers (round counts).
   * 60s (the sweep interval) to 365 days.
   */
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

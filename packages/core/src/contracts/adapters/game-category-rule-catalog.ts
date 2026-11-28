import * as z from 'zod';
import { GameCategoryRuleKeySchema, type GameCategoryRuleKey } from '../schemas/game.js';
import { createToken, type Token } from './token.js';

export type GameCategoryRuleChange = {
  providerIds: readonly string[];
  tagIds: readonly string[];
  playabilityChanged: boolean;
};

export type GameCategoryRuleResolveInput<Params = unknown> = {
  params: Params;
  candidateIds: readonly string[] | null;
  now: Date;
};

export type GameCategoryRuleDefinition<Params = unknown> = {
  key: GameCategoryRuleKey;
  paramsSchema: z.ZodType<Params>;
  exposesReporting?: boolean;
  resolve(input: GameCategoryRuleResolveInput<Params>): Promise<string[]>;
  validate?(params: Params): Promise<string | null>;
  isAffectedBy?(params: Params, change: GameCategoryRuleChange): boolean;
};

export type GameCategoryRuleCatalog = {
  get(key: string): GameCategoryRuleDefinition | undefined;
  list(): GameCategoryRuleDefinition[];
};

export function defineGameCategoryRule<Params>(
  definition: Omit<GameCategoryRuleDefinition<Params>, 'key'> & { key: string },
): GameCategoryRuleDefinition<Params> {
  return { ...definition, key: GameCategoryRuleKeySchema.parse(definition.key) };
}

export function createGameCategoryRuleCatalog(
  definitions: readonly GameCategoryRuleDefinition[],
): GameCategoryRuleCatalog {
  const byKey = new Map<string, GameCategoryRuleDefinition>();
  for (const definition of definitions) {
    if (byKey.has(definition.key)) {
      throw new Error(`Duplicate game category rule definition: ${definition.key}`);
    }
    byKey.set(definition.key, definition);
  }
  return {
    get: (key) => byKey.get(key),
    list: () => [...byKey.values()],
  };
}

export const GAME_CATEGORY_RULE_CATALOG: Token<GameCategoryRuleCatalog> =
  createToken<GameCategoryRuleCatalog>('GAME_CATEGORY_RULE_CATALOG');

/**
 * Operator-extensible catalog of category membership rule kinds. A rule-mode category
 * stores an ordered list of clauses, each naming a definition here by key; the gaming
 * module runs them as a pipeline - every clause narrows the games the previous one left -
 * and materializes the result into `game_category_game`. Nothing resolves a rule at
 * request time. A definition's `resolve()` may read any source it likes - the seam takes
 * no Drizzle dependency, so it belongs in contracts. Ships three built-ins ('providers',
 * 'tags', 'most_played'); an overlay rebinds GAME_CATEGORY_RULE_CATALOG to add or remove
 * definitions - it is a plain (non-sealed) token.
 */
import * as z from 'zod';
import { GameCategoryRuleKeySchema, type GameCategoryRuleKey } from '../schemas/game.js';
import { createToken, type Token } from './token.js';

/**
 * What a catalogue write could have moved, as far as a rule can tell: the providers and
 * tags whose game sets changed, and whether any game's playability flipped.
 */
export type GameCategoryRuleChange = {
  providerIds: readonly string[];
  tagIds: readonly string[];
  playabilityChanged: boolean;
};

export type GameCategoryRuleResolveInput<Params = unknown> = {
  params: Params;
  /**
   * The games the clauses before this one left, in their order. `null` for a rule's
   * first clause: the whole catalogue, which a definition should query rather than load.
   */
  candidateIds: readonly string[] | null;
  now: Date;
};

export type GameCategoryRuleDefinition<Params = unknown> = {
  key: GameCategoryRuleKey;
  /** A real Zod schema (not a duck-typed parser) so the admin route can emit its JSON Schema. */
  paramsSchema: z.ZodType<Params>;
  /**
   * True when the order or content of `resolve()` reveals reporting data an admin with
   * only `game-config:view` must not infer - a revenue ranking, say. Previewing, saving in
   * rule mode, or re-evaluating a rule with such a clause also needs `report:view`. No
   * built-in sets it: which games are most played is what the resulting category shows
   * players anyway.
   */
  exposesReporting?: boolean;
  /**
   * The matching games, best first. Must be a subset of `candidateIds` when that is not
   * null - anything else is dropped. A throw leaves the category's games untouched.
   */
  resolve(input: GameCategoryRuleResolveInput<Params>): Promise<string[]>;
  /**
   * A problem with `params` only a lookup can find (an id that does not exist), as a
   * message for the admin - or null. Checked when a rule is saved.
   */
  validate?(params: Params): Promise<string | null>;
  /**
   * Whether `change` could alter what these params match, for event-driven
   * re-evaluation. A definition without it is refreshed by the periodic sweep and on
   * demand only.
   */
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

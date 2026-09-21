import type { AdminGameReporting, GameCategoryRuleDefinition } from '@openora/core/contracts';
import type { DrizzleService } from '@openora/core/server';
import { createProvidersRule } from './providers-rule.js';
import { createTagsRule } from './tags-rule.js';
import { createMostPlayedRule } from './most-played-rule.js';

/**
 * The three built-in membership rule kinds. Bound into GAME_CATEGORY_RULE_CATALOG by the
 * gaming plugin; an overlay rebinding the (non-sealed) token can add its own definitions
 * alongside or instead of these, e.g. new releases, a game type, a metadata attribute
 * (RTP, volatility) or an exclusion (docs/modules/gaming.md).
 */
export function createDefaultGameCategoryRules(
  drizzle: DrizzleService,
  reporting: AdminGameReporting,
): GameCategoryRuleDefinition[] {
  return [
    createProvidersRule(drizzle),
    createTagsRule(drizzle),
    createMostPlayedRule(drizzle, reporting),
  ];
}

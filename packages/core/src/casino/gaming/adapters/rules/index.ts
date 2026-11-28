import type { AdminGameReporting, GameCategoryRuleDefinition } from '@openora/core/contracts';
import type { DrizzleService } from '@openora/core/server';
import { createProvidersRule } from './providers-rule.js';
import { createTagsRule } from './tags-rule.js';
import { createMostPlayedRule } from './most-played-rule.js';

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

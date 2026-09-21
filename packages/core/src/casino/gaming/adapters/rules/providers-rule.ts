import { and, asc, inArray, sql } from 'drizzle-orm';
import { ProvidersRuleParamsSchema, defineGameCategoryRule } from '@openora/core/contracts';
import type { DrizzleService } from '@openora/core/server';
import { game, gameProvider } from '../../schema/index.js';

/**
 * Games of ANY listed provider, playable or not - exactly as a manual category can hold an
 * inactive game; readers already hide unplayable games from players. Ordered by name.
 */
export function createProvidersRule(drizzle: DrizzleService) {
  return defineGameCategoryRule({
    key: 'providers',
    paramsSchema: ProvidersRuleParamsSchema,
    async resolve({ params, candidateIds }) {
      const rows = await drizzle.db
        .select({ id: game.id })
        .from(game)
        .where(
          and(
            inArray(game.providerId, params.providerIds),
            candidateIds
              ? sql`${game.id} = ANY(${sql.param([...candidateIds])}::uuid[])`
              : undefined,
          ),
        )
        .orderBy(asc(game.name), asc(game.id));
      return rows.map((row) => row.id);
    },
    async validate(params) {
      const rows = await drizzle.db
        .select({ id: gameProvider.id })
        .from(gameProvider)
        .where(inArray(gameProvider.id, params.providerIds));
      const found = new Set(rows.map((row) => row.id));
      const missing = params.providerIds.find((id) => !found.has(id));
      return missing ? `Game provider not found: ${missing}` : null;
    },
    isAffectedBy: (params, change) =>
      params.providerIds.some((id) => change.providerIds.includes(id)),
  });
}

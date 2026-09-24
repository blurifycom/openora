import { and, asc, eq, exists, inArray, sql } from 'drizzle-orm';
import { TagsRuleParamsSchema, defineGameCategoryRule } from '@openora/core/contracts';
import type { DrizzleService } from '@openora/core/server';
import { game, gameTag, gameTagGame } from '../../schema/index.js';

/**
 * Games carrying ANY listed tag, playable or not. Two 'tags' clauses in one rule require
 * a game to carry a tag from each. A tag deleted after the rule was saved simply stops
 * matching. Ordered by name.
 */
export function createTagsRule(drizzle: DrizzleService) {
  return defineGameCategoryRule({
    key: 'tags',
    paramsSchema: TagsRuleParamsSchema,
    async resolve({ params, candidateIds }) {
      const db = drizzle.db;
      const rows = await db
        .select({ id: game.id })
        .from(game)
        .where(
          and(
            exists(
              db
                .select({ one: sql`1` })
                .from(gameTagGame)
                .where(
                  and(eq(gameTagGame.gameId, game.id), inArray(gameTagGame.tagId, params.tagIds)),
                ),
            ),
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
        .select({ id: gameTag.id })
        .from(gameTag)
        .where(inArray(gameTag.id, params.tagIds));
      const found = new Set(rows.map((row) => row.id));
      const missing = params.tagIds.find((id) => !found.has(id));
      return missing ? `Game tag not found: ${missing}` : null;
    },
    isAffectedBy: (params, change) => params.tagIds.some((id) => change.tagIds.includes(id)),
  });
}

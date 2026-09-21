import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { DRIZZLE } from '@openora/core/server';
import {
  ADMIN_GAME_REPORTING,
  GAME_CATEGORY_RULE_CATALOG,
  createGameCategoryRuleCatalog,
  defineGameCategoryRule,
} from '@openora/core/contracts';
import { createDefaultGameCategoryRules } from '@openora/core/casino/server';
import { game } from '@openora/core/casino/schema/gaming';
import { and, eq, sql } from 'drizzle-orm';
import * as z from 'zod';

/**
 * Proves GAME_CATEGORY_RULE_CATALOG is a genuinely replaceable seam: an overlay rebinds
 * it, keeping the built-ins and adding one operator-supplied kind - games of a game type.
 * It declares no `isAffectedBy`, so only a save, an on-demand run or the sweep refreshes it.
 */
export default {
  id: 'test-custom-category-rule',
  dependsOn: ['gaming'],
  register(ctx) {
    ctx.provide(GAME_CATEGORY_RULE_CATALOG, (c) =>
      createGameCategoryRuleCatalog([
        ...createDefaultGameCategoryRules(c.get(DRIZZLE), c.get(ADMIN_GAME_REPORTING)),
        defineGameCategoryRule({
          key: 'test_game_type',
          paramsSchema: z
            .object({ gameType: z.enum(['original', 'casino', 'sportsbook']) })
            .strict(),
          async resolve({ params, candidateIds }) {
            const rows = await c
              .get(DRIZZLE)
              .db.select({ id: game.id })
              .from(game)
              .where(
                and(
                  eq(game.gameType, params.gameType),
                  candidateIds
                    ? sql`${game.id} = ANY(${sql.param([...candidateIds])}::uuid[])`
                    : undefined,
                ),
              );
            return rows.map((row) => row.id);
          },
        }),
      ]),
    );
  },
} as const satisfies Plugin<CoreTokenCatalog>;

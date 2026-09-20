import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { DRIZZLE } from '@openora/core/server';
import { GAME_SORT_CATALOG, createGameSortCatalog, defineGameSort } from '@openora/core/contracts';
import { createDefaultGameSorts } from '@openora/core/casino/server';
import * as z from 'zod';

/**
 * Proves GAME_SORT_CATALOG is a genuinely replaceable seam: an overlay rebinds it,
 * keeping the built-ins and adding one operator-supplied definition. `rank()` orders by
 * raw game id, descending - deterministic and independent of name or manual position, so
 * a test can compute the expected order itself and confirm this definition actually ran.
 */
export default {
  id: 'test-custom-game-sort',
  dependsOn: ['gaming'],
  register(ctx) {
    ctx.provide(GAME_SORT_CATALOG, (c) =>
      createGameSortCatalog([
        ...createDefaultGameSorts(c.get(DRIZZLE)),
        defineGameSort({
          key: 'test_id_desc',
          directions: ['asc'],
          paramsSchema: z.object({}),
          async rank({ gameIds }) {
            return [...gameIds].sort().reverse();
          },
        }),
      ]),
    );
  },
} as const satisfies Plugin<CoreTokenCatalog>;

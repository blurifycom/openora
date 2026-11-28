import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { DRIZZLE } from '@openora/core/server';
import { GAME_SORT_CATALOG, createGameSortCatalog } from '@openora/core/contracts';
import { createDefaultGameSorts } from '@openora/core/casino/server';

export default {
  id: 'test-no-manual-sort',
  dependsOn: ['gaming'],
  register(ctx) {
    ctx.provide(GAME_SORT_CATALOG, (c) =>
      createGameSortCatalog(
        createDefaultGameSorts(c.get(DRIZZLE)).filter((d) => d.key !== 'manual'),
      ),
    );
  },
} as const satisfies Plugin<CoreTokenCatalog>;

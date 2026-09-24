import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { DRIZZLE } from '@openora/core/server';
import { GAME_SORT_CATALOG, createGameSortCatalog } from '@openora/core/contracts';
import { createDefaultGameSorts } from '@openora/core/casino/server';

/**
 * Rebinds GAME_SORT_CATALOG without 'manual', proving the reorder route's own guard: a
 * drag always tries to switch the category to manual sort (docs/modules/gaming.md), and must
 * reject with a field error rather than silently write positions if an operator's
 * overlay ever drops the built-in.
 */
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

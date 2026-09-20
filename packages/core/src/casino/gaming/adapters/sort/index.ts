import type { GameSortDefinition } from '@openora/core/contracts';
import type { DrizzleService } from '@openora/core/server';
import { createManualGameSort } from './manual-game-sort.js';
import { createNameGameSort } from './name-game-sort.js';

/**
 * The two built-in sorts. Bound into GAME_SORT_CATALOG by the gaming plugin; an overlay
 * rebinding the (non-sealed) token can add its own definitions alongside or instead of
 * these, e.g. an attribute sort (RTP, volatility) or a stats sort (revenue, plays) - both
 * deliberately out of scope for core (docs/modules/gaming.md).
 */
export function createDefaultGameSorts(drizzle: DrizzleService): GameSortDefinition[] {
  return [createManualGameSort(drizzle), createNameGameSort(drizzle)];
}

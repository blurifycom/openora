import type { GameSortDefinition } from '@openora/core/contracts';
import type { DrizzleService } from '@openora/core/server';
import { createManualGameSort } from './manual-game-sort.js';
import { createNameGameSort } from './name-game-sort.js';

export function createDefaultGameSorts(drizzle: DrizzleService): GameSortDefinition[] {
  return [createManualGameSort(drizzle), createNameGameSort(drizzle)];
}

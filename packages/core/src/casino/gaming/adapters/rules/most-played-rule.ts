import { and, eq, sql } from 'drizzle-orm';
import {
  MostPlayedRuleParamsSchema,
  defineGameCategoryRule,
  type AdminGameReporting,
} from '@openora/core/contracts';
import type { DrizzleService } from '@openora/core/server';
import { game, gameProvider } from '../../schema/index.js';
import { playableGameCondition } from '../../../shared/game-catalog.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The `limit` most-played games - by completed rounds over the last `periodDays` days -
 * most played first. Ranks playable games only, so an inactive game never takes a slot a
 * player would see as a gap, and never admits a game with no completed round in the
 * window - a quiet catalogue yields fewer than `limit` games rather than arbitrary ones.
 *
 * Round counts come from ADMIN_GAME_REPORTING, the game performance report's own
 * aggregation, so an overlay that rebinds the report also drives this rule. A count is
 * currency-neutral: rounds in every currency weigh the same.
 */
export function createMostPlayedRule(drizzle: DrizzleService, reporting: AdminGameReporting) {
  return defineGameCategoryRule({
    key: 'most_played',
    paramsSchema: MostPlayedRuleParamsSchema,
    async resolve({ params, candidateIds, now }) {
      const playable = await drizzle.db
        .select({ id: game.id })
        .from(game)
        .innerJoin(gameProvider, eq(game.providerId, gameProvider.id))
        .where(
          and(
            playableGameCondition(),
            candidateIds
              ? sql`${game.id} = ANY(${sql.param([...candidateIds])}::uuid[])`
              : undefined,
          ),
        );
      if (playable.length === 0) {
        return [];
      }
      const playableIds = new Set(playable.map((row) => row.id));
      const performance = await reporting.listGamePerformance({
        dateFrom: new Date(now.getTime() - params.periodDays * DAY_MS),
        dateTo: now,
        sortBy: 'roundsPlayed',
        sortDir: 'desc',
        // Always narrowed to the playable candidates, so the report aggregates rounds
        // for those games only - never the whole round table for a catalogue slice.
        gameIds: [...playableIds],
      });
      return performance
        .filter((row) => row.roundsPlayed > 0 && playableIds.has(row.gameId))
        .slice(0, params.limit)
        .map((row) => row.gameId);
    },
    // No isAffectedBy: this kind aggregates the round table, so it is refreshed by the
    // periodic sweep (which its rolling window needs anyway) and on demand - never by a
    // burst of catalogue events. A game that goes unplayable in between is hidden from
    // players by the readers regardless.
  });
}

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
 * Round counts come from ADMIN_GAME_REPORTING, so an overlay that rebinds the report also
 * drives this rule: its `rankAllGamesByRounds` for a first clause and `rankGamesByRounds`
 * otherwise when bound, each counting and limiting in one query, else the full game
 * performance report. A count is currency-neutral: rounds in every currency weigh the same.
 */
export function createMostPlayedRule(drizzle: DrizzleService, reporting: AdminGameReporting) {
  return defineGameCategoryRule({
    key: 'most_played',
    paramsSchema: MostPlayedRuleParamsSchema,
    exposesReporting: true,
    async resolve({ params, candidateIds, now }) {
      const window = {
        dateFrom: new Date(now.getTime() - params.periodDays * DAY_MS),
        dateTo: now,
      };
      const playableAmong = async (ids: readonly string[] | null) => {
        const rows = await drizzle.db
          .select({ id: game.id })
          .from(game)
          .innerJoin(gameProvider, eq(game.providerId, gameProvider.id))
          .where(
            and(
              playableGameCondition(),
              ids ? sql`${game.id} = ANY(${sql.param([...ids])}::uuid[])` : undefined,
            ),
          );
        return new Set(rows.map((row) => row.id));
      };
      if (!candidateIds && reporting.rankAllGamesByRounds) {
        // The whole catalogue in one ranking; only when unplayable games took slots does
        // it fall back to listing the playable games and ranking those.
        const ranked = await reporting.rankAllGamesByRounds({ ...window, limit: params.limit });
        const playableIds = await playableAmong(ranked.map((row) => row.gameId));
        const kept = ranked.filter((row) => row.roundsPlayed > 0 && playableIds.has(row.gameId));
        if (kept.length >= params.limit || ranked.length < params.limit) {
          return kept.slice(0, params.limit).map((row) => row.gameId);
        }
      }
      const playableIds = await playableAmong(candidateIds);
      if (playableIds.size === 0) {
        return [];
      }
      // Always narrowed to the playable candidates, so rounds are counted for those games
      // only - never the whole round table for a catalogue slice.
      const range = { ...window, gameIds: [...playableIds] };
      const ranked = reporting.rankGamesByRounds
        ? await reporting.rankGamesByRounds({ ...range, limit: params.limit })
        : await reporting.listGamePerformance({
            ...range,
            sortBy: 'roundsPlayed',
            sortDir: 'desc',
          });
      return ranked
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

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
  });
}

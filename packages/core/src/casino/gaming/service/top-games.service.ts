import { McpToolError, dayRangeInstants, type AdminGameReporting } from '@openora/core/contracts';
import {
  TOP_GAMES_MAX_CURRENCIES,
  resolveTopGamesRange,
  type TopGames,
  type TopGamesInput,
} from '../contract/index.js';

/**
 * gaming.top_games, ranked by the bound ADMIN_GAME_REPORTING: the agent counts the games as the
 * back office game performance report does, an operator's rebound report included.
 */
export async function topGames(
  reporting: AdminGameReporting,
  { currency, gameType, sortBy, sortDir, limit, ...dates }: TopGamesInput,
  now = new Date(),
): Promise<TopGames> {
  if (!reporting.rankGamesPerCurrency) {
    throw new McpToolError('report_unavailable');
  }
  const range = resolveTopGamesRange(dates, now);
  const { from, to } = dayRangeInstants(range);
  const ranking = await reporting.rankGamesPerCurrency({
    dateFrom: from,
    dateTo: to,
    ...(currency ? { currency: currency.toUpperCase() } : {}),
    ...(gameType ? { gameType } : {}),
    sortBy,
    sortDir,
    limit,
    maxCurrencies: TOP_GAMES_MAX_CURRENCIES,
  });
  return { ...range, sortBy, sortDir, ...ranking };
}

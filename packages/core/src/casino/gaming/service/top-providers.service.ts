import { McpToolError, dayRangeInstants, type AdminGameReporting } from '@openora/core/contracts';
import {
  TOP_GAMES_MAX_CURRENCIES,
  resolveTopGamesRange,
  type TopProviders,
  type TopProvidersInput,
} from '../contract/index.js';

export async function topProviders(
  reporting: AdminGameReporting,
  { currency, gameType, sortBy, sortDir, limit, ...dates }: TopProvidersInput,
  now = new Date(),
): Promise<TopProviders> {
  if (!reporting.rankProvidersPerCurrency) {
    throw new McpToolError('report_unavailable');
  }
  const range = resolveTopGamesRange(dates, now);
  const { from, to } = dayRangeInstants(range);
  const ranking = await reporting.rankProvidersPerCurrency({
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

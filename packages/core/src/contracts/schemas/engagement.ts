import * as z from 'zod';

export const leaderboardMetrics = ['wagers', 'wins'] as const;
export const LeaderboardMetricSchema = z.enum(leaderboardMetrics);
export type LeaderboardMetric = z.infer<typeof LeaderboardMetricSchema>;

export const leaderboardPeriods = ['daily', 'weekly'] as const;
export const LeaderboardPeriodSchema = z.enum(leaderboardPeriods);
export type LeaderboardPeriod = z.infer<typeof LeaderboardPeriodSchema>;

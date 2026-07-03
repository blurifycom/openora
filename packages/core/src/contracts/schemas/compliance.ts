import * as z from 'zod';

export const limitTypes = ['deposit', 'wager', 'loss'] as const;
export const LimitTypeSchema = z.enum(limitTypes);
export type LimitType = z.infer<typeof LimitTypeSchema>;

export const limitPeriods = ['daily', 'weekly', 'monthly'] as const;
export const LimitPeriodSchema = z.enum(limitPeriods);
export type LimitPeriod = z.infer<typeof LimitPeriodSchema>;

export const geoRuleActions = ['allow', 'block'] as const;
export const GeoRuleActionSchema = z.enum(geoRuleActions);
export type GeoRuleAction = z.infer<typeof GeoRuleActionSchema>;

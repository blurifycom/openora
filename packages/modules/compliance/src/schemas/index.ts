import * as z from 'zod';

export const LimitSchema = z.object({
  id: z.string(),
  userId: z.string(),
  type: z.enum(['deposit', 'wager', 'loss']),
  amount: z.number(),
  period: z.enum(['daily', 'weekly', 'monthly']),
  createdAt: z.string(),
});

export const GeoRuleSchema = z.object({
  id: z.string(),
  countryCode: z.string(),
  action: z.enum(['allow', 'block']),
  createdAt: z.string(),
});

export type Limit = z.infer<typeof LimitSchema>;
export type GeoRule = z.infer<typeof GeoRuleSchema>;

export const UpsertLimitInputSchema = z.object({
  type: z.enum(['deposit', 'wager', 'loss']),
  amount: z.number(),
  period: z.enum(['daily', 'weekly', 'monthly']),
});

export const DeleteLimitInputSchema = z.object({
  id: z.string(),
});

export const AddGeoRuleInputSchema = z.object({
  countryCode: z.string(),
  action: z.enum(['allow', 'block']),
});

export type UpsertLimitInput = z.infer<typeof UpsertLimitInputSchema>;
export type AddGeoRuleInput = z.infer<typeof AddGeoRuleInputSchema>;

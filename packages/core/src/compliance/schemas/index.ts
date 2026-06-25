import * as z from 'zod';
import { UuidSchema } from '@blurifycom/core/contracts';

export const LimitSchema = z.object({
  id: z.string(),
  userId: UuidSchema,
  type: z.enum(['deposit', 'wager', 'loss']),
  amount: z.number(),
  period: z.enum(['daily', 'weekly', 'monthly']),
  createdAt: z.iso.datetime(),
});

export const GeoRuleSchema = z.object({
  id: z.string(),
  countryCode: z.string(),
  action: z.enum(['allow', 'block']),
  createdAt: z.iso.datetime(),
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

import * as z from 'zod';
import { UuidSchema } from '@blurifycom/core/contracts';

export const LimitSchema = z.object({
  id: UuidSchema,
  userId: UuidSchema,
  type: z.enum(['deposit', 'wager', 'loss']),
  amount: z.number(),
  period: z.enum(['daily', 'weekly', 'monthly']),
  createdAt: z.iso.datetime(),
});

export const GeoRuleSchema = z.object({
  id: UuidSchema,
  countryCode: z.string(),
  action: z.enum(['allow', 'block']),
  createdAt: z.iso.datetime(),
});

export type Limit = z.infer<typeof LimitSchema>;
export type GeoRule = z.infer<typeof GeoRuleSchema>;

export const UpsertLimitInputSchema = LimitSchema.pick({ type: true, amount: true, period: true });

export const DeleteLimitInputSchema = LimitSchema.pick({ id: true });

export const AddGeoRuleInputSchema = GeoRuleSchema.pick({ countryCode: true, action: true });

export type UpsertLimitInput = z.infer<typeof UpsertLimitInputSchema>;
export type AddGeoRuleInput = z.infer<typeof AddGeoRuleInputSchema>;

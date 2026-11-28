import { MoneyAmountSchema } from '@openora/core/contracts';
import z from 'zod';

export const HighRiskAmountBreachDetailSchema = z.object({
  amount: MoneyAmountSchema,
  threshold: MoneyAmountSchema,
});
export type HighRiskAmountBreachDetail = z.infer<typeof HighRiskAmountBreachDetailSchema>;

export const HighRiskCountBreachDetailSchema = z.object({
  count: z.number().int(),
  thresholdCount: z.number().int(),
  thresholdDays: z.number().int(),
});
export type HighRiskCountBreachDetail = z.infer<typeof HighRiskCountBreachDetailSchema>;

export const HighRiskAssignMetadataSchema = z.object({
  amountBreach: HighRiskAmountBreachDetailSchema.nullable(),
  countBreach: HighRiskCountBreachDetailSchema.nullable(),
});
export type HighRiskAssignMetadata = z.infer<typeof HighRiskAssignMetadataSchema>;

/** @alias */
export const PlayerTagAssignMetadataSchema = HighRiskAssignMetadataSchema;
export type PlayerTagAssignMetadata = z.infer<typeof PlayerTagAssignMetadataSchema>;

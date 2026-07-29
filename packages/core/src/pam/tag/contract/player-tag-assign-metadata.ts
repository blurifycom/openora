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

// Alias kept distinct from HighRiskAssignMetadataSchema so a second tag's assign-metadata
// shape can join this union later without touching call sites - same extensibility
// precedent as RgFlagDetail in the sibling compliance module.
export const PlayerTagAssignMetadataSchema = HighRiskAssignMetadataSchema;
export type PlayerTagAssignMetadata = z.infer<typeof PlayerTagAssignMetadataSchema>;

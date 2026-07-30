import { oc } from '@orpc/contract';
import * as z from 'zod';
import { DateRangeSchema } from '@openora/core/contracts';

export const FUNNEL_STAGES = [
  'registered',
  'email_verified',
  'first_deposit',
  'first_bet',
] as const;
export const FunnelStageNameSchema = z.enum(FUNNEL_STAGES);
export type FunnelStageName = z.infer<typeof FunnelStageNameSchema>;

export const FunnelStageSchema = z.object({
  stage: FunnelStageNameSchema,
  count: z.number().int().nonnegative(),
  dropOffRate: z.number().min(0).max(1).nullable(),
});
export type FunnelStage = z.infer<typeof FunnelStageSchema>;

export const ConversionFunnelSchema = z.array(FunnelStageSchema);
export type ConversionFunnel = z.infer<typeof ConversionFunnelSchema>;

export const FunnelQuerySchema = DateRangeSchema;
export type FunnelQuery = z.infer<typeof FunnelQuerySchema>;

export const funnelContract = {
  conversion: oc
    .route({ method: 'GET', path: '/analytics/funnel/conversion' })
    .input(FunnelQuerySchema)
    .output(ConversionFunnelSchema),
};

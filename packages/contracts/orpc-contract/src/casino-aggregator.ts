import { oc } from '@orpc/contract';
import * as z from 'zod';

export const SyncResultSchema = z.object({
  synced: z.number(),
  failed: z.number(),
});

export const AggregatorProviderSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  isActive: z.boolean(),
  gameCount: z.number(),
});

export const CallbackInputSchema = z.object({
  provider: z.string(),
  event: z.string(),
  payload: z.unknown(),
});

export const CallbackResultSchema = z.object({
  ok: z.literal(true),
});

export const casinoAggregatorContract = {
  sync: oc.route({ method: 'POST', path: '/casino-aggregator/sync' }).output(SyncResultSchema),

  listProviders: oc
    .route({ method: 'GET', path: '/casino-aggregator/providers' })
    .output(z.array(AggregatorProviderSummarySchema)),

  callback: oc
    .route({ method: 'POST', path: '/casino-aggregator/callback' })
    .input(CallbackInputSchema)
    .output(CallbackResultSchema),
};

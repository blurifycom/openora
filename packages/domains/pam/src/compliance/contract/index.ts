import { oc } from '@orpc/contract';
import * as z from 'zod';

export const LimitSchema = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  type: z.enum(['deposit', 'wager', 'loss']),
  amount: z.number(),
  period: z.enum(['daily', 'weekly', 'monthly']),
  createdAt: z.string(),
});

export const GeoRuleSchema = z.object({
  id: z.uuid(),
  countryCode: z.string(),
  action: z.enum(['allow', 'block']),
  createdAt: z.string(),
});

const UpsertLimitInputSchema = z.object({
  type: z.enum(['deposit', 'wager', 'loss']),
  amount: z.number(),
  period: z.enum(['daily', 'weekly', 'monthly']),
});

const DeleteLimitInputSchema = z.object({
  id: z.uuid(),
});

const AddGeoRuleInputSchema = z.object({
  countryCode: z.string(),
  action: z.enum(['allow', 'block']),
});

const GeoCheckOutputSchema = z.object({
  allowed: z.boolean(),
  countryCode: z.string().nullable(),
  reason: z.string().nullable(),
});

export const complianceContract = {
  getLimits: oc.route({ method: 'GET', path: '/compliance/limits' }).output(z.array(LimitSchema)),

  upsertLimit: oc
    .route({ method: 'PUT', path: '/compliance/limits' })
    .input(UpsertLimitInputSchema)
    .output(LimitSchema),

  deleteLimit: oc
    .route({ method: 'DELETE', path: '/compliance/limits/{id}' })
    .input(DeleteLimitInputSchema)
    .output(z.object({ success: z.literal(true) })),

  geoCheck: oc.route({ method: 'GET', path: '/compliance/geo-check' }).output(GeoCheckOutputSchema),

  addGeoRule: oc
    .route({ method: 'POST', path: '/compliance/geo-rules' })
    .input(AddGeoRuleInputSchema)
    .output(GeoRuleSchema),

  listGeoRules: oc
    .route({ method: 'GET', path: '/compliance/geo-rules' })
    .output(z.array(GeoRuleSchema)),
};

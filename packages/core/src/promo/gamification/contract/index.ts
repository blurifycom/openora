import { oc } from '@orpc/contract';
import * as z from 'zod';
import { TimestampSchema, UuidSchema } from '@openora/core/contracts';

// Canonical request/response shapes for the Gamification module. This is the
// single source of truth - the router validates against it, live OpenAPI + the typed
// client are emitted from it. Derive related shapes with .pick()/.omit()/.extend()
// rather than re-typing fields. Promote anything shared across domains to
// @openora/core/contracts. This dir is isomorphic: Zod + @openora/core/contracts only.
export const GamificationSchema = z.object({
  id: UuidSchema,
  createdAt: TimestampSchema,
});

export type Gamification = z.infer<typeof GamificationSchema>;

export const gamificationContract = {
  list: oc.route({ method: 'GET', path: '/gamification' }).output(z.array(GamificationSchema)),
};

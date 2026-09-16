import { oc } from '@orpc/contract';
import * as z from 'zod';
import { TimestampSchema, UuidSchema } from '@openora/core/contracts';

// Canonical request/response shapes for the Bonus module. This is the
// single source of truth - the router validates against it, live OpenAPI + the typed
// client are emitted from it. Derive related shapes with .pick()/.omit()/.extend()
// rather than re-typing fields. Promote anything shared across domains to
// @openora/core/contracts. This dir is isomorphic: Zod + @openora/core/contracts only.
export const BonusSchema = z.object({
  id: UuidSchema,
  createdAt: TimestampSchema,
});

export type Bonus = z.infer<typeof BonusSchema>;

export const bonusContract = {
  list: oc.route({ method: 'GET', path: '/bonus' }).output(z.array(BonusSchema)),
};

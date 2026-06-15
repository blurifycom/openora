import { oc } from '@orpc/contract';
import * as z from 'zod';
import { PlayerSchema } from '@oss/shared-schemas';

/**
 * Player-facing self-profile contract. Distinct from the admin PAM surface
 * (`playerContract`): these routes resolve the caller from the VERIFIED
 * better-auth session (getUserId) and are NOT admin-guarded. Covers the
 * preference fields the player
 * owns (display name, country, display currency, language). Auth-bound fields
 * (email, password, avatar, 2FA) live on the identity contract.
 */

// Derived from PlayerSchema (the canonical player shape) - the editable subset,
// all optional. No field shapes are re-typed here.
export const UpdatePlayerProfileInputSchema = PlayerSchema.pick({
  displayName: true,
  country: true,
  currency: true,
  language: true,
}).partial();

export type UpdatePlayerProfileInput = z.infer<typeof UpdatePlayerProfileInputSchema>;

export const profileContract = {
  get: oc.route({ method: 'GET', path: '/profile' }).output(PlayerSchema),

  update: oc
    .route({ method: 'PATCH', path: '/profile' })
    .input(UpdatePlayerProfileInputSchema)
    .output(PlayerSchema),
};

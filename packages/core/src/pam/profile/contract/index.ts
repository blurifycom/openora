import { oc } from '@orpc/contract';
import { PlayerSchema, UpdatePlayerProfileInputSchema } from '@oss/core/contracts';

/**
 * Player-facing self-profile contract. Distinct from the admin PAM surface
 * (`playerContract`): these routes resolve the caller from the VERIFIED
 * better-auth session (getUserId) and are NOT admin-guarded. Covers the
 * preference fields the player
 * owns (display name, country, display currency, language). Auth-bound fields
 * (email, password, avatar, 2FA) live on the identity contract.
 *
 * The editable input shape (UpdatePlayerProfileInputSchema) lives in
 * shared-schemas so the frontend SDK can reference it without importing this
 * domain. Re-exported here for back-compat with existing contract imports.
 */
export { UpdatePlayerProfileInputSchema, type UpdatePlayerProfileInput } from '@oss/core/contracts';

export const profileContract = {
  get: oc.route({ method: 'GET', path: '/profile' }).output(PlayerSchema),

  update: oc
    .route({ method: 'PATCH', path: '/profile' })
    .input(UpdatePlayerProfileInputSchema)
    .output(PlayerSchema),
};

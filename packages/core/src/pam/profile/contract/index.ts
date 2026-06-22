import { oc } from '@orpc/contract';
import { PlayerSchema, UpdatePlayerProfileInputSchema } from '@blurifycom/core/contracts';

// Player-facing self-profile contract. Caller resolved from the verified
// better-auth session; not admin-guarded. Auth-bound fields (email, password,
// avatar, 2FA) live on the identity contract.
export {
  UpdatePlayerProfileInputSchema,
  type UpdatePlayerProfileInput,
} from '@blurifycom/core/contracts';

export const profileContract = {
  get: oc.route({ method: 'GET', path: '/profile' }).output(PlayerSchema),

  update: oc
    .route({ method: 'PATCH', path: '/profile' })
    .input(UpdatePlayerProfileInputSchema)
    .output(PlayerSchema),
};

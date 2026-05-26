import { oc } from '@orpc/contract';
import { UserSchema, LoginInputSchema, RegisterInputSchema } from '@oss/shared-schemas';
import * as z from 'zod';

const SessionSchema = z.object({
  token: z.string(),
  expiresAt: z.string(),
});

export const identityContract = {
  register: oc
    .route({ method: 'POST', path: '/identity/register' })
    .input(RegisterInputSchema)
    .output(z.object({ user: UserSchema })),

  login: oc
    .route({ method: 'POST', path: '/identity/login' })
    .input(LoginInputSchema)
    .output(z.object({ user: UserSchema, session: SessionSchema })),

  logout: oc
    .route({ method: 'POST', path: '/identity/logout' })
    .output(z.object({ success: z.literal(true) })),

  me: oc.route({ method: 'GET', path: '/identity/me' }).output(UserSchema.nullable()),
};

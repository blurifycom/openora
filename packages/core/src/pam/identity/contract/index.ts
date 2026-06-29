import { oc } from '@orpc/contract';
import {
  UserSchema,
  UuidSchema,
  LoginInputSchema,
  RegisterInputSchema,
  Enable2faInputSchema,
  Enable2faResultSchema,
  Verify2faInputSchema,
  Disable2faInputSchema,
  RequestPasswordResetInputSchema,
  ResetPasswordInputSchema,
  VerifyEmailInputSchema,
  UpdateProfileInputSchema,
  ChangePasswordInputSchema,
  ChangeEmailInputSchema,
  IdentitySuccessSchema,
} from '@blurifycom/core/contracts';
import { PageQuerySchema, paginated } from '@blurifycom/core/contracts/kit';
import * as z from 'zod';

const SessionSchema = z.object({
  token: z.string(),
  expiresAt: z.string(),
});

const SessionItemSchema = z.object({
  id: z.string(),
  token: z.string(),
  expiresAt: z.string(),
  createdAt: z.string(),
  ipAddress: z.string().nullable().optional(),
  userAgent: z.string().nullable().optional(),
});

export const identityContract = {
  register: oc
    .route({ method: 'POST', path: '/identity/register' })
    .input(RegisterInputSchema)
    .output(z.object({ user: UserSchema })),

  // When 2FA is enabled, better-auth withholds the session and signals `twoFactorRedirect`; client must then call verify2fa.
  login: oc
    .route({ method: 'POST', path: '/identity/login' })
    .input(LoginInputSchema)
    .output(
      z.object({
        user: UserSchema.optional(),
        session: SessionSchema.optional(),
        twoFactorRedirect: z.boolean().optional(),
      }),
    ),

  logout: oc.route({ method: 'POST', path: '/identity/logout' }).output(IdentitySuccessSchema),

  me: oc.route({ method: 'GET', path: '/identity/me' }).output(UserSchema.nullable()),

  enable2fa: oc
    .route({ method: 'POST', path: '/identity/2fa/enable' })
    .input(Enable2faInputSchema)
    .output(Enable2faResultSchema),

  verify2fa: oc
    .route({ method: 'POST', path: '/identity/2fa/verify' })
    .input(Verify2faInputSchema)
    .output(IdentitySuccessSchema),

  disable2fa: oc
    .route({ method: 'POST', path: '/identity/2fa/disable' })
    .input(Disable2faInputSchema)
    .output(IdentitySuccessSchema),

  requestPasswordReset: oc
    .route({ method: 'POST', path: '/identity/password/forgot' })
    .input(RequestPasswordResetInputSchema)
    .output(IdentitySuccessSchema),

  resetPassword: oc
    .route({ method: 'POST', path: '/identity/password/reset' })
    .input(ResetPasswordInputSchema)
    .output(IdentitySuccessSchema),

  changePassword: oc
    .route({ method: 'POST', path: '/identity/password/change' })
    .input(ChangePasswordInputSchema)
    .output(IdentitySuccessSchema),

  sendEmailVerification: oc
    .route({ method: 'POST', path: '/identity/email/verify/send' })
    .output(IdentitySuccessSchema),

  verifyEmail: oc
    .route({ method: 'POST', path: '/identity/email/verify' })
    .input(VerifyEmailInputSchema)
    .output(IdentitySuccessSchema),

  changeEmail: oc
    .route({ method: 'POST', path: '/identity/email/change' })
    .input(ChangeEmailInputSchema)
    .output(IdentitySuccessSchema),

  updateProfile: oc
    .route({ method: 'PATCH', path: '/identity/profile' })
    .input(UpdateProfileInputSchema)
    .output(z.object({ user: UserSchema })),

  unlockUser: oc
    .route({ method: 'POST', path: '/identity/unlock' })
    .input(z.object({ userId: UuidSchema }))
    .output(IdentitySuccessSchema),

  sessions: {
    list: oc
      .route({ method: 'GET', path: '/identity/sessions' })
      .input(PageQuerySchema.extend({ playerId: UuidSchema }))
      .output(paginated(SessionItemSchema)),

    revoke: oc
      .route({ method: 'POST', path: '/identity/sessions/revoke' })
      .input(z.object({ playerId: UuidSchema, token: z.string() }))
      .output(IdentitySuccessSchema),

    revokeAll: oc
      .route({ method: 'POST', path: '/identity/sessions/revoke-all' })
      .input(z.object({ playerId: UuidSchema }))
      .output(IdentitySuccessSchema),
  },
};

import { oc } from '@orpc/contract';
import {
  UserSchema,
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
} from '@oss/shared-schemas';
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

  // When the caller has 2FA enabled, better-auth withholds the session and
  // signals `twoFactorRedirect`; the client must then call verify2fa. Hence
  // user/session are optional on this output.
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

  // --- Two-factor (TOTP) ---
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

  // --- Password reset ---
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

  // --- Email verification + change ---
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

  // --- Profile ---
  updateProfile: oc
    .route({ method: 'PATCH', path: '/identity/profile' })
    .input(UpdateProfileInputSchema)
    .output(z.object({ user: UserSchema })),
};

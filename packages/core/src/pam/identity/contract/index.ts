import { oc, eventIterator } from '@orpc/contract';
import {
  UserSchema,
  UuidSchema,
  LoginInputSchema,
  RegisterInputSchema,
  RegisterOutputSchema,
  UsernameAvailabilityInputSchema,
  UsernameAvailabilityOutputSchema,
  RegistrationPolicySchema,
  Enable2faInputSchema,
  Enable2faResultSchema,
  Verify2faInputSchema,
  Disable2faInputSchema,
  SendTwoFactorOtpResultSchema,
  TwoFactorDeliveryMethodSchema,
  TwoFactorStatusSchema,
  RegenerateBackupCodesInputSchema,
  BackupCodesResultSchema,
  TrustCurrentDeviceInputSchema,
  RequestPasswordResetInputSchema,
  VerifyPasswordResetOtpInputSchema,
  ResetPasswordInputSchema,
  ResendEmailVerificationInputSchema,
  VerifyEmailInputSchema,
  UpdateProfileInputSchema,
  ChangePasswordInputSchema,
  RequestEmailChangeInputSchema,
  ConfirmEmailChangeInputSchema,
  IdentitySuccessSchema,
  Verify2faOutputSchema,
  TimestampSchema,
  PhoneLoginRequestInputSchema,
  PhoneLoginRequestOutputSchema,
  PhoneLoginVerifyInputSchema,
  LoginSecurityStateSchema,
  SecurityControlsSchema,
  SetAutoLogoutInputSchema,
  SetLoginWithdrawalAlertsInputSchema,
  SetRequireTwoFactorOnLoginInputSchema,
  SetWithdrawalPinInputSchema,
  RemoveWithdrawalPinInputSchema,
  SetAntiPhishingCodeInputSchema,
  PhoneVerificationRequestInputSchema,
  PhoneVerificationRequestOutputSchema,
  PhoneVerificationConfirmInputSchema,
} from '@openora/core/contracts';
import { PageQuerySchema, SortOrderSchema, paginated } from '@openora/core/contracts/kit';
import * as z from 'zod';

export const SessionSchema = z.object({
  token: z.string(),
  expiresAt: TimestampSchema,
});

export const SessionItemSchema = z.object({
  id: UuidSchema,
  expiresAt: TimestampSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  lastSeenAt: TimestampSchema.nullable(),
  ipAddress: z.string().nullable().optional(),
  userAgent: z.string().nullable().optional(),
  deviceLabel: z.string(),
  browser: z.string().nullable(),
  os: z.string().nullable(),
  current: z.boolean(),
});
export type SessionItem = z.infer<typeof SessionItemSchema>;

export const ActiveSessionItemSchema = SessionItemSchema.extend({
  userId: UuidSchema,
  email: z.email(),
  role: z.string(),
});
export type ActiveSessionItem = z.infer<typeof ActiveSessionItemSchema>;

export const TrustedDeviceItemSchema = z.object({
  id: UuidSchema,
  label: z.string(),
  browser: z.string().nullable(),
  os: z.string().nullable(),
  ipAddress: z.string().nullable(),
  lastUsedAt: TimestampSchema,
  expiresAt: TimestampSchema,
  isCurrent: z.boolean(),
});
export type TrustedDeviceItem = z.infer<typeof TrustedDeviceItemSchema>;

export const AdminSecurityStatusSchema = z.object({
  twoFactorEnabled: z.boolean(),
  backupCodesRemaining: z.number().int().nonnegative().nullable(),
  enrollmentRequired: z.boolean(),
  trustedDeviceDays: z.number().int().nonnegative(),
  trustedDeviceUntil: TimestampSchema.nullable(),
  lockedUntil: TimestampSchema.nullable(),
});
export type AdminSecurityStatus = z.infer<typeof AdminSecurityStatusSchema>;

export const SESSION_SORT_BY_VALUES = ['createdAt', 'expiresAt', 'updatedAt'] as const;
export const SessionSortBySchema = z.enum(SESSION_SORT_BY_VALUES).default('createdAt');
export type SessionSortBy = z.infer<typeof SessionSortBySchema>;

export const identityContract = {
  register: oc
    .route({ method: 'POST', path: '/identity/register' })
    .input(RegisterInputSchema)
    .output(RegisterOutputSchema),

  usernameAvailable: oc
    .route({ method: 'GET', path: '/identity/username-available' })
    .input(UsernameAvailabilityInputSchema)
    .output(UsernameAvailabilityOutputSchema),

  registrationPolicy: oc
    .route({ method: 'GET', path: '/identity/registration-policy' })
    .output(RegistrationPolicySchema),

  login: oc
    .route({ method: 'POST', path: '/identity/login' })
    .input(LoginInputSchema)
    .output(
      z.object({
        user: UserSchema.optional(),
        session: SessionSchema.optional(),
        twoFactorRedirect: z.boolean().optional(),
        twoFactorMethod: TwoFactorDeliveryMethodSchema.optional(),
        security: LoginSecurityStateSchema.optional(),
        trustedDeviceDays: z.number().int().nonnegative().optional(),
      }),
    ),

  phoneLoginRequest: oc
    .route({ method: 'POST', path: '/identity/phone-login/request' })
    .input(PhoneLoginRequestInputSchema)
    .output(PhoneLoginRequestOutputSchema),

  phoneLoginVerify: oc
    .route({ method: 'POST', path: '/identity/phone-login/verify' })
    .input(PhoneLoginVerifyInputSchema)
    .output(
      z.object({ user: UserSchema, session: SessionSchema, security: LoginSecurityStateSchema }),
    ),

  logout: oc.route({ method: 'POST', path: '/identity/logout' }).output(IdentitySuccessSchema),

  me: oc.route({ method: 'GET', path: '/identity/me' }).output(UserSchema.nullable()),

  security: {
    me: oc.route({ method: 'GET', path: '/identity/security/me' }).output(SecurityControlsSchema),

    loginWithdrawalAlerts: oc
      .route({ method: 'POST', path: '/identity/security/login-withdrawal-alerts' })
      .input(SetLoginWithdrawalAlertsInputSchema)
      .output(SecurityControlsSchema),

    autoLogout: oc
      .route({ method: 'POST', path: '/identity/security/auto-logout' })
      .input(SetAutoLogoutInputSchema)
      .output(SecurityControlsSchema),

    requireTwoFactorOnLogin: oc
      .route({ method: 'POST', path: '/identity/security/require-two-factor' })
      .input(SetRequireTwoFactorOnLoginInputSchema)
      .output(SecurityControlsSchema),

    setWithdrawalPin: oc
      .route({ method: 'POST', path: '/identity/security/withdrawal-pin' })
      .input(SetWithdrawalPinInputSchema)
      .output(SecurityControlsSchema),

    removeWithdrawalPin: oc
      .route({ method: 'DELETE', path: '/identity/security/withdrawal-pin' })
      .input(RemoveWithdrawalPinInputSchema)
      .output(SecurityControlsSchema),

    setAntiPhishingCode: oc
      .route({ method: 'POST', path: '/identity/security/anti-phishing-code' })
      .input(SetAntiPhishingCodeInputSchema)
      .output(SecurityControlsSchema),
  },

  phoneVerification: {
    request: oc
      .route({ method: 'POST', path: '/identity/phone-verification/request' })
      .input(PhoneVerificationRequestInputSchema)
      .output(PhoneVerificationRequestOutputSchema),

    confirm: oc
      .route({ method: 'POST', path: '/identity/phone-verification/confirm' })
      .input(PhoneVerificationConfirmInputSchema)
      .output(SecurityControlsSchema),
  },

  streamSession: oc
    .route({ method: 'GET', path: '/identity/session/stream' })
    .output(
      eventIterator(
        z.discriminatedUnion('type', [
          z.object({ type: z.literal('revoked') }),
          z.object({ type: z.literal('unlocked') }),
        ]),
      ),
    ),

  enable2fa: oc
    .route({ method: 'POST', path: '/identity/2fa/enable' })
    .input(Enable2faInputSchema)
    .output(Enable2faResultSchema),

  verify2fa: oc
    .route({ method: 'POST', path: '/identity/2fa/verify' })
    .input(Verify2faInputSchema)
    .output(Verify2faOutputSchema),

  disable2fa: oc
    .route({ method: 'POST', path: '/identity/2fa/disable' })
    .input(Disable2faInputSchema)
    .output(IdentitySuccessSchema),

  sendTwoFactorOtp: oc
    .route({ method: 'POST', path: '/identity/2fa/otp/send' })
    .output(SendTwoFactorOtpResultSchema),

  twoFactorStatus: oc
    .route({ method: 'GET', path: '/identity/2fa/status' })
    .output(TwoFactorStatusSchema),

  regenerateBackupCodes: oc
    .route({ method: 'POST', path: '/identity/2fa/backup-codes/regenerate' })
    .input(RegenerateBackupCodesInputSchema)
    .output(BackupCodesResultSchema),

  requestPasswordReset: oc
    .route({ method: 'POST', path: '/identity/password/forgot' })
    .input(RequestPasswordResetInputSchema)
    .output(IdentitySuccessSchema),

  verifyPasswordResetOtp: oc
    .route({ method: 'POST', path: '/identity/password/verify-otp' })
    .input(VerifyPasswordResetOtpInputSchema)
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
    .input(ResendEmailVerificationInputSchema)
    .output(IdentitySuccessSchema),

  verifyEmail: oc
    .route({ method: 'POST', path: '/identity/email/verify' })
    .input(VerifyEmailInputSchema)
    .output(
      z.object({
        user: UserSchema.optional(),
        session: SessionSchema.optional(),
        twoFactorRedirect: z.boolean().optional(),
      }),
    ),

  requestEmailChange: oc
    .route({ method: 'POST', path: '/identity/email/change/request' })
    .input(RequestEmailChangeInputSchema)
    .output(IdentitySuccessSchema),

  confirmEmailChange: oc
    .route({ method: 'POST', path: '/identity/email/change/confirm' })
    .input(ConfirmEmailChangeInputSchema)
    .output(IdentitySuccessSchema),

  updateProfile: oc
    .route({ method: 'PATCH', path: '/identity/profile' })
    .input(UpdateProfileInputSchema)
    .output(z.object({ user: UserSchema })),

  unlockUser: oc
    .route({ method: 'POST', path: '/identity/unlock' })
    .input(z.object({ userId: UuidSchema }))
    .output(IdentitySuccessSchema),

  adminRequestPasswordReset: oc
    .route({ method: 'POST', path: '/identity/admin/password-reset' })
    .input(z.object({ userId: UuidSchema }))
    .output(IdentitySuccessSchema),

  sessions: {
    list: oc
      .route({ method: 'GET', path: '/identity/sessions' })
      .input(
        PageQuerySchema.extend({
          userId: UuidSchema,
          sortBy: SessionSortBySchema.optional(),
          sortOrder: SortOrderSchema.default('desc').optional(),
        }),
      )
      .output(paginated(SessionItemSchema)),

    revoke: oc
      .route({ method: 'POST', path: '/identity/sessions/revoke' })
      .input(z.object({ userId: UuidSchema, id: UuidSchema }))
      .output(IdentitySuccessSchema),

    revokeAll: oc
      .route({ method: 'POST', path: '/identity/sessions/revoke-all' })
      .input(z.object({ userId: UuidSchema }))
      .output(IdentitySuccessSchema),

    listMine: oc
      .route({ method: 'GET', path: '/identity/sessions/me' })
      .input(
        PageQuerySchema.extend({
          sortBy: SessionSortBySchema.optional(),
          sortOrder: SortOrderSchema.default('desc').optional(),
        }),
      )
      .output(paginated(SessionItemSchema)),

    revokeMine: oc
      .route({ method: 'POST', path: '/identity/sessions/me/revoke' })
      .input(z.object({ id: UuidSchema }))
      .output(IdentitySuccessSchema),

    listAll: oc
      .route({ method: 'GET', path: '/identity/sessions/all' })
      .input(
        PageQuerySchema.extend({
          role: z.string().optional(),
          query: z.string().optional(),
          sortBy: SessionSortBySchema.optional(),
          sortOrder: SortOrderSchema.default('desc').optional(),
        }),
      )
      .output(paginated(ActiveSessionItemSchema)),
  },

  adminSecurity: {
    status: oc
      .route({ method: 'GET', path: '/identity/admin-security/status' })
      .output(AdminSecurityStatusSchema),

    trustedDevices: oc
      .route({ method: 'GET', path: '/identity/admin-security/trusted-devices' })
      .output(z.array(TrustedDeviceItemSchema)),

    trustCurrentDevice: oc
      .route({ method: 'POST', path: '/identity/admin-security/trusted-devices/trust' })
      .input(TrustCurrentDeviceInputSchema)
      .output(IdentitySuccessSchema),

    revokeTrustedDevice: oc
      .route({ method: 'POST', path: '/identity/admin-security/trusted-devices/revoke' })
      .input(z.object({ id: UuidSchema }))
      .output(IdentitySuccessSchema),

    resetUserTwoFactor: oc
      .route({ method: 'POST', path: '/identity/admin-security/2fa/reset' })
      .input(z.object({ userId: UuidSchema, reason: z.string().trim().min(10).max(500) }))
      .output(IdentitySuccessSchema),

    resetPlayerTwoFactor: oc
      .route({ method: 'POST', path: '/identity/admin-security/2fa/reset-player' })
      .input(z.object({ userId: UuidSchema, reason: z.string().trim().min(10).max(500) }))
      .output(IdentitySuccessSchema),

    revokeUserTrustedDevice: oc
      .route({ method: 'POST', path: '/identity/admin-security/trusted-devices/revoke-for-user' })
      .input(z.object({ userId: UuidSchema, id: UuidSchema }))
      .output(IdentitySuccessSchema),
  },
};

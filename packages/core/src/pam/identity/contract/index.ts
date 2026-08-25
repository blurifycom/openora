import { oc, eventIterator } from '@orpc/contract';
import {
  UserSchema,
  UuidSchema,
  LoginInputSchema,
  RegisterInputSchema,
  RegisterOutputSchema,
  UsernameAvailabilityInputSchema,
  UsernameAvailabilityOutputSchema,
  Enable2faInputSchema,
  Enable2faResultSchema,
  Verify2faInputSchema,
  Disable2faInputSchema,
  RequestPasswordResetInputSchema,
  VerifyPasswordResetOtpInputSchema,
  ResetPasswordInputSchema,
  ResendEmailVerificationInputSchema,
  VerifyEmailInputSchema,
  UpdateProfileInputSchema,
  ChangePasswordInputSchema,
  ChangeEmailInputSchema,
  IdentitySuccessSchema,
  TimestampSchema,
  PhoneLoginRequestInputSchema,
  PhoneLoginRequestOutputSchema,
  PhoneLoginVerifyInputSchema,
  LoginSecurityStateSchema,
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
  // Last time better-auth refreshed the session - "last used" in a device list.
  updatedAt: TimestampSchema,
  // Last admin request seen on this session. Finer-grained than `updatedAt`, which
  // better-auth only refreshes once per updateAge window.
  lastSeenAt: TimestampSchema.nullable(),
  ipAddress: z.string().nullable().optional(),
  userAgent: z.string().nullable().optional(),
  // Human-readable rendering of userAgent for the session list.
  deviceLabel: z.string(),
  browser: z.string().nullable(),
  os: z.string().nullable(),
  // True for the session making the request; false everywhere it cannot be known
  // (eg an admin listing someone else's devices).
  current: z.boolean(),
});
export type SessionItem = z.infer<typeof SessionItemSchema>;

// A session row plus who it belongs to - the cross-user list is useless without it.
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
  // True when the operator requires a second factor and this account has none - the
  // Backoffice renders the enrolment flow and nothing else while it holds.
  enrollmentRequired: z.boolean(),
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

  // When 2FA is enabled, better-auth withholds the session and signals `twoFactorRedirect`; client must then call verify2fa.
  login: oc
    .route({ method: 'POST', path: '/identity/login' })
    .input(LoginInputSchema)
    .output(
      z.object({
        user: UserSchema.optional(),
        session: SessionSchema.optional(),
        twoFactorRedirect: z.boolean().optional(),
        security: LoginSecurityStateSchema.optional(),
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
    .output(IdentitySuccessSchema),

  disable2fa: oc
    .route({ method: 'POST', path: '/identity/2fa/disable' })
    .input(Disable2faInputSchema)
    .output(IdentitySuccessSchema),

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

  // Unauthenticated: the player has no session until the emailed code is verified.
  // Always answers success, so it never reveals whether the address has an account.
  sendEmailVerification: oc
    .route({ method: 'POST', path: '/identity/email/verify/send' })
    .input(ResendEmailVerificationInputSchema)
    .output(IdentitySuccessSchema),

  // Verifying the registration code is what mints the session (sign-up never does). A
  // 2FA-enrolled account is verified but NOT signed in - it gets `twoFactorRedirect` and
  // completes the challenge through `login`, exactly as that route signals it.
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

    // Self-service twins of the admin routes above: the caller's own devices only,
    // scoped by the verified session rather than a `userId` input.
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

    // Cross-user view: every active session on the platform, for the admin who holds
    // sessions:view. The per-user route above needs a userId and so cannot answer
    // "who is logged in right now".
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

    revokeTrustedDevice: oc
      .route({ method: 'POST', path: '/identity/admin-security/trusted-devices/revoke' })
      .input(z.object({ id: UuidSchema }))
      .output(IdentitySuccessSchema),

    // Cross-user twin, for a Super Admin cutting off someone else's trusted device.
    revokeUserTrustedDevice: oc
      .route({ method: 'POST', path: '/identity/admin-security/trusted-devices/revoke-for-user' })
      .input(z.object({ userId: UuidSchema, id: UuidSchema }))
      .output(IdentitySuccessSchema),
  },
};

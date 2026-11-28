import { z } from 'zod';
import { UuidSchema, TimestampSchema, TimezoneSchema } from './common.js';

export const THEMES = ['light', 'dark', 'system'] as const;
export const OTP_CODE_LENGTH = 6;
export const OTP_EXPIRES_IN_SEC = 3600;
export const ThemeSchema = z.enum(THEMES);
export type Theme = z.infer<typeof ThemeSchema>;

export const LanguageSchema = z.string().max(35);
export const LanguageTagSchema = LanguageSchema.regex(
  /^[a-zA-Z]{2,8}(?:-(?:[a-zA-Z0-9]{2,8}|[a-zA-Z0-9](?=-)))*$/,
);

export const UsernameSchema = z
  .string()
  .min(3)
  .max(20)
  .regex(/^[a-zA-Z0-9_]+$/)
  .transform((value) => value.toLowerCase());

export const UserSchema = z.object({
  id: UuidSchema,
  email: z.email(),
  name: z.string().min(1).max(255),
  username: UsernameSchema,
  emailVerified: z.boolean(),
  image: z.url().nullable().optional(),
  theme: ThemeSchema,
  language: LanguageSchema,
  phoneNumber: z.string().nullable().optional(),
  phoneVerified: z.boolean().optional(),
  twoFactorEnabled: z.boolean(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const E164PhoneSchema = z.string().regex(/^\+[1-9][0-9]{7,14}$/);

export const PhoneLoginRequestInputSchema = z.object({ phone: E164PhoneSchema });

export const PhoneLoginRequestOutputSchema = z.object({
  expiresAt: TimestampSchema,
  resendAfter: TimestampSchema,
});

export const PhoneLoginVerifyInputSchema = z.object({
  phone: E164PhoneSchema,
  code: z.string().regex(/^[0-9]{6}$/),
  rememberMe: z.boolean().optional(),
  timezone: TimezoneSchema.optional(),
});

export const PHONE_LOGIN_ERROR_REASONS = [
  'otp_cancelled',
  'rg_blocked',
  'account_suspended',
] as const;
export const PhoneLoginErrorReasonSchema = z.enum(PHONE_LOGIN_ERROR_REASONS);

export const PHONE_LOGIN_OTP_INVALID_REASONS = ['expired', 'wrong_code'] as const;
export const PhoneLoginOtpInvalidReasonSchema = z.enum(PHONE_LOGIN_OTP_INVALID_REASONS);

export const REGISTRATION_FAILURE_REASONS = [
  'registration_disabled',
  'rate_limited',
  'geo_blocked',
  'username_taken',
  'username_blocked',
  'email_already_registered',
  'error',
] as const;
export const RegistrationFailureReasonSchema = z.enum(REGISTRATION_FAILURE_REASONS);

export const OrganizationSchema = z.object({
  id: UuidSchema,
  name: z.string().min(1).max(255),
  slug: z.string().min(1).max(100),
  logo: z.url().optional(),
  createdAt: TimestampSchema,
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const MemberSchema = z.object({
  id: UuidSchema,
  userId: UuidSchema,
  organizationId: UuidSchema,
  role: z.enum(['owner', 'admin', 'member']),
  createdAt: TimestampSchema,
});

export const PASSWORD_MAX_LENGTH = 128;
export const PasswordSchema = z.string().min(12).max(PASSWORD_MAX_LENGTH);

const credentialsBase = z.object({
  email: z.email(),
  password: z.string().min(8),
});

export const LoginAudienceSchema = z.enum(['staff', 'player']);

export const LoginInputSchema = credentialsBase.extend({
  audience: LoginAudienceSchema.optional(),
  rememberMe: z.boolean().optional(),
  timezone: TimezoneSchema.optional(),
});

export const LoginSecurityStateSchema = z.object({
  attemptsRemaining: z.number().int().nonnegative(),
  lockoutUntil: TimestampSchema.nullable(),
});

export const ACQUISITION_MAX_PARAMS = 10;

const AcquisitionParamKeySchema = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);
const AcquisitionParamValueSchema = z
  .string()
  .max(256)
  .regex(/^[^\p{Cc}\p{Cs}]+$/u);

const AcquisitionParamsSchema = z
  .record(z.string(), z.unknown())
  .transform((params) =>
    Object.fromEntries(
      Object.entries(params)
        .flatMap(([key, value]) => {
          const parsed = AcquisitionParamValueSchema.safeParse(value);
          return AcquisitionParamKeySchema.safeParse(key).success && parsed.success
            ? [[key, parsed.data] as const]
            : [];
        })
        .slice(0, ACQUISITION_MAX_PARAMS),
    ),
  )
  .refine((params) => Object.keys(params).length > 0);

export const RegistrationAcquisitionSchema = z.object({
  params: AcquisitionParamsSchema,
  firstSeenAt: z.iso.datetime({ offset: true }).optional().catch(undefined),
  landingHost: z
    .string()
    .max(253)
    .regex(/^[A-Za-z0-9.-]+(:\d{1,5})?$/)
    .optional()
    .catch(undefined),
});
export type RegistrationAcquisition = z.infer<typeof RegistrationAcquisitionSchema>;

export const RegisterInputSchema = credentialsBase.extend({
  password: PasswordSchema,
  username: UsernameSchema,
  acceptedTerms: z.literal(true),
  acceptedAge: z.literal(true),
  timezone: TimezoneSchema.optional(),
  acquisition: RegistrationAcquisitionSchema.optional().catch(undefined),
});

export const RegisterOutputSchema = z.object({ status: z.literal('check-email') });

export const UsernameAvailabilityInputSchema = z.object({ username: UsernameSchema });

export const UsernameAvailabilityOutputSchema = z.object({ available: z.boolean() });

export const RegistrationPolicySchema = z.object({ minPlayerAge: z.number().int() });

export const TWO_FACTOR_DELIVERY_METHODS = ['app', 'email', 'sms'] as const;
export const TwoFactorDeliveryMethodSchema = z.enum(TWO_FACTOR_DELIVERY_METHODS);

export const Enable2faInputSchema = z.object({
  password: z.string().min(8),
  method: TwoFactorDeliveryMethodSchema.default('app'),
});

export const Enable2faResultSchema = z.object({
  totpUri: z.string().min(1).optional(),
  backupCodes: z.array(z.string()),
  maskedDestination: z.string().min(1).optional(),
});

export const TwoFactorChallengeMethodSchema = z.enum(['totp', 'backup_code', 'otp']);

export const TotpStepUpCodeSchema = z.string().length(6);

export const StepUpMethodSchema = z.enum(['live', 'backup_code']);

export function normalizeBackupCode(code: string): string {
  const trimmed = code.trim();
  return /^[A-Za-z0-9]{10}$/.test(trimmed) ? `${trimmed.slice(0, 5)}-${trimmed.slice(5)}` : trimmed;
}

export const BackupCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9]{5}-?[A-Za-z0-9]{5}$/)
  .transform(normalizeBackupCode);

export const SecondFactorCodeSchema = z.string().min(6).max(11);

export const Verify2faInputSchema = z.object({
  code: SecondFactorCodeSchema,
  method: TwoFactorChallengeMethodSchema.default('totp'),
  trustDevice: z.boolean().default(false),
  timezone: TimezoneSchema.optional(),
});

export const RegenerateBackupCodesInputSchema = z.object({
  password: z.string().min(8),
  code: TotpStepUpCodeSchema,
});

export const TrustCurrentDeviceInputSchema = z.object({
  code: TotpStepUpCodeSchema,
  password: z.string().min(8),
});

export const BackupCodesResultSchema = z.object({
  backupCodes: z.array(z.string()),
});

export const SendTwoFactorOtpResultSchema = z.object({
  maskedDestination: z.string().min(1),
});

export const TwoFactorStatusSchema = z.object({
  enabled: z.boolean(),
  method: TwoFactorDeliveryMethodSchema.nullable(),
  maskedEmail: z.string().min(1),
  maskedPhone: z.string().min(1).nullable(),
  backupCodesRemaining: z.number().int().nonnegative().nullable(),
});

export const Disable2faInputSchema = z.union([
  z.object({
    password: z.string().min(8),
    method: z.literal('backup_code'),
    code: BackupCodeSchema,
  }),
  z.object({
    password: z.string().min(8),
    method: z.literal('live').default('live'),
    code: TotpStepUpCodeSchema,
  }),
]);

export const AUTO_LOGOUT_DURATIONS = ['15m', '1h', '24h', '7d', '30d'] as const;
export const AutoLogoutDurationSchema = z.enum(AUTO_LOGOUT_DURATIONS);
export type AutoLogoutDuration = z.infer<typeof AutoLogoutDurationSchema>;

export const AUTO_LOGOUT_MINUTES: Record<AutoLogoutDuration, number> = {
  '15m': 15,
  '1h': 60,
  '24h': 24 * 60,
  '7d': 7 * 24 * 60,
  '30d': 30 * 24 * 60,
};

export const ADMIN_IDLE_MINUTES = 30;

export const SecurityControlsSchema = z.object({
  passwordMeetsPolicy: z.boolean(),
  emailVerified: z.boolean(),
  phoneNumber: E164PhoneSchema.nullable(),
  phoneVerified: z.boolean(),
  twoFactorEnabled: z.boolean(),
  loginWithdrawalAlertsEnabled: z.boolean(),
  withdrawalPinSet: z.boolean(),
  autoLogoutDuration: AutoLogoutDurationSchema,
  requireTwoFactorOnLogin: z.boolean(),
  trustedDeviceDays: z.number().int().nonnegative(),
  antiPhishingCode: z.string().nullable(),
});

export const SetLoginWithdrawalAlertsInputSchema = z.object({ enabled: z.boolean() });

export const SetAutoLogoutInputSchema = z.object({ duration: AutoLogoutDurationSchema });

export const SetRequireTwoFactorOnLoginInputSchema = z.object({ enabled: z.boolean() });

export const SetAntiPhishingCodeInputSchema = z.object({ code: z.string().trim().min(1).max(255) });

export const WithdrawalPinSchema = z.string().regex(/^[0-9]{4}$/);

export const SetWithdrawalPinInputSchema = z
  .object({
    pin: WithdrawalPinSchema,
    confirmPin: WithdrawalPinSchema,
    currentPassword: z.string().min(8),
    totpCode: TotpStepUpCodeSchema.optional(),
  })
  .refine((v) => v.pin === v.confirmPin, {
    message: 'PIN and confirmation must match.',
    path: ['confirmPin'],
  });

export const RemoveWithdrawalPinInputSchema = z.object({
  currentPassword: z.string().min(8),
  totpCode: TotpStepUpCodeSchema.optional(),
});

export const PhoneVerificationRequestInputSchema = z.object({
  phone: E164PhoneSchema,
  currentPassword: z.string().min(8),
  totpCode: TotpStepUpCodeSchema.optional(),
});

export const PhoneVerificationRequestOutputSchema = z.object({
  expiresAt: TimestampSchema,
  resendAfter: TimestampSchema,
});

export const PhoneVerificationConfirmInputSchema = z.object({
  code: z.string().regex(/^[0-9]{6}$/),
});

export const RequestPasswordResetInputSchema = z.object({
  email: z.email(),
});

export const ResetPasswordInputSchema = z.object({
  email: z.email(),
  otp: z.string().length(OTP_CODE_LENGTH),
  token: z.string().min(1).optional(),
  newPassword: PasswordSchema,
});

export const VerifyPasswordResetOtpInputSchema = ResetPasswordInputSchema.pick({
  email: true,
  otp: true,
});

export const ResendEmailVerificationInputSchema = z.object({
  email: z.email(),
});

export const VerifyEmailInputSchema = z.object({
  email: z.email(),
  otp: z.string().length(OTP_CODE_LENGTH),
  timezone: TimezoneSchema.optional(),
});

export const UpdateProfileInputSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    image: z.url().nullable().optional(),
    theme: ThemeSchema.optional(),
    language: LanguageSchema.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'Provide at least one field to update',
  });

export const ChangePasswordInputSchema = z.object({
  currentPassword: z.string().min(8),
  newPassword: PasswordSchema,
});

export const RequestEmailChangeInputSchema = z.object({
  newEmail: z.email(),
  currentPassword: z.string().min(8),
  totpCode: TotpStepUpCodeSchema.optional(),
});

export const ConfirmEmailChangeInputSchema = z.object({
  newEmail: z.email(),
  otp: z.string().length(OTP_CODE_LENGTH),
});

export const IdentitySuccessSchema = z.object({ success: z.literal(true) });

export const Verify2faOutputSchema = IdentitySuccessSchema.extend({
  trustGranted: z.boolean(),
});

export type IdentitySuccess = z.infer<typeof IdentitySuccessSchema>;
export type Verify2faOutput = z.infer<typeof Verify2faOutputSchema>;
export type User = z.infer<typeof UserSchema>;
export type Organization = z.infer<typeof OrganizationSchema>;
export type Member = z.infer<typeof MemberSchema>;
export type LoginInput = z.infer<typeof LoginInputSchema>;
export type LoginSecurityState = z.infer<typeof LoginSecurityStateSchema>;
export type RegisterInput = z.infer<typeof RegisterInputSchema>;
export type RegisterOutput = z.infer<typeof RegisterOutputSchema>;
export type UsernameAvailabilityInput = z.infer<typeof UsernameAvailabilityInputSchema>;
export type UsernameAvailabilityOutput = z.infer<typeof UsernameAvailabilityOutputSchema>;
export type RegistrationPolicy = z.infer<typeof RegistrationPolicySchema>;
export type Enable2faInput = z.infer<typeof Enable2faInputSchema>;
export type Enable2faResult = z.infer<typeof Enable2faResultSchema>;
export type Verify2faInput = z.infer<typeof Verify2faInputSchema>;
export type TwoFactorChallengeMethod = z.infer<typeof TwoFactorChallengeMethodSchema>;
export type StepUpMethod = z.infer<typeof StepUpMethodSchema>;
export type TwoFactorDeliveryMethod = z.infer<typeof TwoFactorDeliveryMethodSchema>;
export type TwoFactorStatus = z.infer<typeof TwoFactorStatusSchema>;
export type SendTwoFactorOtpResult = z.infer<typeof SendTwoFactorOtpResultSchema>;
export type RegenerateBackupCodesInput = z.infer<typeof RegenerateBackupCodesInputSchema>;
export type BackupCodesResult = z.infer<typeof BackupCodesResultSchema>;
export type TrustCurrentDeviceInput = z.infer<typeof TrustCurrentDeviceInputSchema>;
export type Disable2faInput = z.infer<typeof Disable2faInputSchema>;
export type RequestPasswordResetInput = z.infer<typeof RequestPasswordResetInputSchema>;
export type ResetPasswordInput = z.infer<typeof ResetPasswordInputSchema>;
export type VerifyPasswordResetOtpInput = z.infer<typeof VerifyPasswordResetOtpInputSchema>;
export type ResendEmailVerificationInput = z.infer<typeof ResendEmailVerificationInputSchema>;
export type VerifyEmailInput = z.infer<typeof VerifyEmailInputSchema>;
export type UpdateProfileInput = z.infer<typeof UpdateProfileInputSchema>;
export type ChangePasswordInput = z.infer<typeof ChangePasswordInputSchema>;
export type RequestEmailChangeInput = z.infer<typeof RequestEmailChangeInputSchema>;
export type ConfirmEmailChangeInput = z.infer<typeof ConfirmEmailChangeInputSchema>;
export type E164Phone = z.infer<typeof E164PhoneSchema>;
export type PhoneLoginRequestInput = z.infer<typeof PhoneLoginRequestInputSchema>;
export type PhoneLoginRequestOutput = z.infer<typeof PhoneLoginRequestOutputSchema>;
export type PhoneLoginVerifyInput = z.infer<typeof PhoneLoginVerifyInputSchema>;
export type SecurityControls = z.infer<typeof SecurityControlsSchema>;
export type SetLoginWithdrawalAlertsInput = z.infer<typeof SetLoginWithdrawalAlertsInputSchema>;
export type SetAutoLogoutInput = z.infer<typeof SetAutoLogoutInputSchema>;
export type SetRequireTwoFactorOnLoginInput = z.infer<typeof SetRequireTwoFactorOnLoginInputSchema>;
export type SetWithdrawalPinInput = z.infer<typeof SetWithdrawalPinInputSchema>;
export type RemoveWithdrawalPinInput = z.infer<typeof RemoveWithdrawalPinInputSchema>;
export type SetAntiPhishingCodeInput = z.infer<typeof SetAntiPhishingCodeInputSchema>;
export type PhoneVerificationRequestInput = z.infer<typeof PhoneVerificationRequestInputSchema>;
export type PhoneVerificationRequestOutput = z.infer<typeof PhoneVerificationRequestOutputSchema>;
export type PhoneVerificationConfirmInput = z.infer<typeof PhoneVerificationConfirmInputSchema>;
export type PhoneLoginErrorReason = z.infer<typeof PhoneLoginErrorReasonSchema>;
export type PhoneLoginOtpInvalidReason = z.infer<typeof PhoneLoginOtpInvalidReasonSchema>;
export type RegistrationFailureReason = z.infer<typeof RegistrationFailureReasonSchema>;

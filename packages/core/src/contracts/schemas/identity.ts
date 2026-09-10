import { z } from 'zod';
import { UuidSchema, TimestampSchema, TimezoneSchema } from './common.js';

export const THEMES = ['light', 'dark', 'system'] as const;
export const OTP_CODE_LENGTH = 6;
export const OTP_EXPIRES_IN_SEC = 3600;
export const ThemeSchema = z.enum(THEMES);
export type Theme = z.infer<typeof ThemeSchema>;

// BCP 47 upper bound - the longest real-world tags stay well under this.
export const LanguageSchema = z.string().max(35);

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

/**
 * Why a registration attempt produced no account. `email_already_registered` is the odd
 * one out: the caller is deliberately told the attempt succeeded, because saying otherwise
 * is an account-enumeration oracle. The audit trail records what actually happened.
 */
export const REGISTRATION_FAILURE_REASONS = [
  'registration_disabled',
  'rate_limited',
  'geo_blocked',
  'username_taken',
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

/**
 * The rule for every password the platform *sets*. Upper-bounded to better-auth's own
 * `maxPasswordLength` default (128), which it enforces itself but only after the fact -
 * on sign-up that surfaces as a generic "Registration is unavailable", and on reset it
 * burns a valid one-time code before rejecting. Bounding it here fails the caller with
 * the real reason instead.
 *
 * Sign-in deliberately does NOT use this: capping the input cannot help (no longer
 * password was ever storable) and would only narrow an existing contract.
 */
export const PasswordSchema = z.string().min(12).max(128);

const credentialsBase = z.object({
  email: z.email(),
  password: z.string().min(8),
});

export const LoginInputSchema = credentialsBase.extend({
  rememberMe: z.boolean().optional(),
  timezone: TimezoneSchema.optional(),
});

export const LoginSecurityStateSchema = z.object({
  attemptsRemaining: z.number().int().nonnegative(),
  lockoutUntil: TimestampSchema.nullable(),
});

export const RegisterInputSchema = credentialsBase.extend({
  password: PasswordSchema,
  username: UsernameSchema,
  acceptedTerms: z.literal(true),
  acceptedAge: z.literal(true),
  timezone: TimezoneSchema.optional(),
});

export const RegisterOutputSchema = z.object({ status: z.literal('check-email') });

export const UsernameAvailabilityInputSchema = z.object({ username: UsernameSchema });

export const UsernameAvailabilityOutputSchema = z.object({ available: z.boolean() });

// How the account receives its second factor. All three share one enrolment - the
// secret and backup codes better-auth mints on enable - and differ only in delivery:
// `app` reads a TOTP off the shared secret, `email` and `sms` have a one-time code
// pushed to the registered address. The account holds exactly one at a time.
export const TWO_FACTOR_DELIVERY_METHODS = ['app', 'email', 'sms'] as const;
export const TwoFactorDeliveryMethodSchema = z.enum(TWO_FACTOR_DELIVERY_METHODS);

export const Enable2faInputSchema = z.object({
  password: z.string().min(8),
  method: TwoFactorDeliveryMethodSchema.default('app'),
});

export const Enable2faResultSchema = z.object({
  // Only the authenticator method has a URI to render as a QR code; `email` and `sms`
  // get their code pushed instead, so there is nothing for the client to display.
  totpUri: z.string().min(1).optional(),
  backupCodes: z.array(z.string()),
  // Where an `email`/`sms` code was sent, masked for display (p***@example.com).
  maskedDestination: z.string().min(1).optional(),
});

// The credentials that clear a challenge. A backup code is single-use and spends
// itself, which is what makes it the recovery path off a lost authenticator; `otp`
// is the pushed code the `email` and `sms` methods deliver.
export const TwoFactorChallengeMethodSchema = z.enum(['totp', 'backup_code', 'otp']);

// A live second-factor code, six digits: a TOTP for the `app` method, a pushed
// one-time code for `email`/`sms`. Used as the fresh factor a step-up action
// (disable 2FA, regenerate backup codes, trust this device) has to clear on top of
// the account password - a backup code is deliberately not accepted here.
export const TotpStepUpCodeSchema = z.string().length(6);

export const Verify2faInputSchema = z.object({
  // A TOTP code is six digits; a backup code is ten characters split by a hyphen.
  code: z.string().min(6).max(11),
  method: TwoFactorChallengeMethodSchema.default('totp'),
  // Suppresses the second factor on this browser until the trust window lapses.
  // Honoured only for `method: 'totp'` - a spent recovery code buys a session, not
  // a 30-day bypass - and only while the operator allows a non-zero window.
  trustDevice: z.boolean().default(false),
  timezone: TimezoneSchema.optional(),
});

export const RegenerateBackupCodesInputSchema = z.object({
  password: z.string().min(8),
  // A fresh authenticator code: rotating the standing recovery credentials is a
  // step-up action, not something a stolen session plus a reused password can do.
  code: TotpStepUpCodeSchema,
});

export const TrustCurrentDeviceInputSchema = z.object({
  code: TotpStepUpCodeSchema,
  password: z.string().min(8),
});

export const BackupCodesResultSchema = z.object({
  backupCodes: z.array(z.string()),
});

// Pushes a one-time code to the account's registered address. Serves both the
// "Resend code" action during enrolment and the send leg of an `email`/`sms`
// challenge at login, so it answers from a live session or a pending challenge alike.
export const SendTwoFactorOtpResultSchema = z.object({
  maskedDestination: z.string().min(1),
});

// What the Security page renders: whether a second factor is active, which one, and
// the addresses a code could go to - masked, because this is read from the session
// rather than re-proved, so it must not hand back a full address or phone number.
export const TwoFactorStatusSchema = z.object({
  enabled: z.boolean(),
  method: TwoFactorDeliveryMethodSchema.nullable(),
  maskedEmail: z.string().min(1),
  // Null when the account has no verified phone - the `sms` method is unavailable then.
  maskedPhone: z.string().min(1).nullable(),
});

export const Disable2faInputSchema = z.object({
  password: z.string().min(8),
  // Disabling the second factor tears down every standing bypass with it, so it
  // takes a fresh authenticator code on top of the password - the same bar as a
  // Super Admin reset, just self-served.
  code: TotpStepUpCodeSchema,
});

// How long a session may sit idle before it is cut. Every account has a window - there
// is deliberately no "off": the longest option already coincides with better-auth's
// absolute 30-day expiry, which this setting does not touch.
export const AUTO_LOGOUT_DURATIONS = ['15m', '1h', '24h', '7d', '30d'] as const;
export const AutoLogoutDurationSchema = z.enum(AUTO_LOGOUT_DURATIONS);
export type AutoLogoutDuration = z.infer<typeof AutoLogoutDurationSchema>;

// The window behind each option, in minutes.
export const AUTO_LOGOUT_MINUTES: Record<AutoLogoutDuration, number> = {
  '15m': 15,
  '1h': 60,
  '24h': 24 * 60,
  '7d': 7 * 24 * 60,
  '30d': 30 * 24 * 60,
};

export const SecurityControlsSchema = z.object({
  passwordMeetsPolicy: z.boolean(),
  emailVerified: z.boolean(),
  phoneNumber: E164PhoneSchema.nullable(),
  phoneVerified: z.boolean(),
  twoFactorEnabled: z.boolean(),
  loginWithdrawalAlertsEnabled: z.boolean(),
  withdrawalPinSet: z.boolean(),
  autoLogoutDuration: AutoLogoutDurationSchema,
  // When set, a trusted device buys nothing: the second factor is asked for on every
  // login regardless of how recently this browser cleared one.
  requireTwoFactorOnLogin: z.boolean(),
});

export const SetLoginWithdrawalAlertsInputSchema = z.object({ enabled: z.boolean() });

export const SetAutoLogoutInputSchema = z.object({ duration: AutoLogoutDurationSchema });

export const SetRequireTwoFactorOnLoginInputSchema = z.object({ enabled: z.boolean() });

export const WithdrawalPinSchema = z.string().regex(/^[0-9]{4}$/);

// Set and Change share this one shape - Change asks for a fresh password/TOTP the same
// as Set, never the current PIN (matches the product's identical Set/Change UX).
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
  // Carried here too: `autoSignInAfterVerification` mints the first session on this route,
  // and verification may come from a different device than sign-up.
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

export const ChangeEmailInputSchema = z.object({
  newEmail: z.email(),
});

export const IdentitySuccessSchema = z.object({ success: z.literal(true) });

export type IdentitySuccess = z.infer<typeof IdentitySuccessSchema>;
export type User = z.infer<typeof UserSchema>;
export type Organization = z.infer<typeof OrganizationSchema>;
export type Member = z.infer<typeof MemberSchema>;
export type LoginInput = z.infer<typeof LoginInputSchema>;
export type LoginSecurityState = z.infer<typeof LoginSecurityStateSchema>;
export type RegisterInput = z.infer<typeof RegisterInputSchema>;
export type RegisterOutput = z.infer<typeof RegisterOutputSchema>;
export type UsernameAvailabilityInput = z.infer<typeof UsernameAvailabilityInputSchema>;
export type UsernameAvailabilityOutput = z.infer<typeof UsernameAvailabilityOutputSchema>;
export type Enable2faInput = z.infer<typeof Enable2faInputSchema>;
export type Enable2faResult = z.infer<typeof Enable2faResultSchema>;
export type Verify2faInput = z.infer<typeof Verify2faInputSchema>;
export type TwoFactorChallengeMethod = z.infer<typeof TwoFactorChallengeMethodSchema>;
export type TwoFactorDeliveryMethod = z.infer<typeof TwoFactorDeliveryMethodSchema>;
export type TwoFactorStatus = z.infer<typeof TwoFactorStatusSchema>;
export type SendTwoFactorOtpResult = z.infer<typeof SendTwoFactorOtpResultSchema>;
export type RegenerateBackupCodesInput = z.infer<typeof RegenerateBackupCodesInputSchema>;
export type TrustCurrentDeviceInput = z.infer<typeof TrustCurrentDeviceInputSchema>;
export type Disable2faInput = z.infer<typeof Disable2faInputSchema>;
export type RequestPasswordResetInput = z.infer<typeof RequestPasswordResetInputSchema>;
export type ResetPasswordInput = z.infer<typeof ResetPasswordInputSchema>;
export type VerifyPasswordResetOtpInput = z.infer<typeof VerifyPasswordResetOtpInputSchema>;
export type ResendEmailVerificationInput = z.infer<typeof ResendEmailVerificationInputSchema>;
export type VerifyEmailInput = z.infer<typeof VerifyEmailInputSchema>;
export type UpdateProfileInput = z.infer<typeof UpdateProfileInputSchema>;
export type ChangePasswordInput = z.infer<typeof ChangePasswordInputSchema>;
export type ChangeEmailInput = z.infer<typeof ChangeEmailInputSchema>;
export type E164Phone = z.infer<typeof E164PhoneSchema>;
export type PhoneLoginRequestInput = z.infer<typeof PhoneLoginRequestInputSchema>;
export type PhoneLoginRequestOutput = z.infer<typeof PhoneLoginRequestOutputSchema>;
export type PhoneLoginVerifyInput = z.infer<typeof PhoneLoginVerifyInputSchema>;
export type SecurityControls = z.infer<typeof SecurityControlsSchema>;
export type SetLoginWithdrawalAlertsInput = z.infer<typeof SetLoginWithdrawalAlertsInputSchema>;
export type SetAutoLogoutInput = z.infer<typeof SetAutoLogoutInputSchema>;
export type SetRequireTwoFactorOnLoginInput = z.infer<typeof SetRequireTwoFactorOnLoginInputSchema>;
export type SetWithdrawalPinInput = z.infer<typeof SetWithdrawalPinInputSchema>;
export type PhoneVerificationRequestInput = z.infer<typeof PhoneVerificationRequestInputSchema>;
export type PhoneVerificationRequestOutput = z.infer<typeof PhoneVerificationRequestOutputSchema>;
export type PhoneVerificationConfirmInput = z.infer<typeof PhoneVerificationConfirmInputSchema>;
export type PhoneLoginErrorReason = z.infer<typeof PhoneLoginErrorReasonSchema>;
export type PhoneLoginOtpInvalidReason = z.infer<typeof PhoneLoginOtpInvalidReasonSchema>;
export type RegistrationFailureReason = z.infer<typeof RegistrationFailureReasonSchema>;

import { z } from 'zod';
import { UuidSchema, TimestampSchema } from './common.js';

export const THEMES = ['light', 'dark', 'system'] as const;
export const OTP_CODE_LENGTH = 6;
export const OTP_EXPIRES_IN_SEC = 3600;
export const ThemeSchema = z.enum(THEMES);
export type Theme = z.infer<typeof ThemeSchema>;

// BCP 47 upper bound - the longest real-world tags stay well under this.
export const LanguageSchema = z.string().max(35);

// The username is the stable, public player identifier. It deliberately has no
// display-name fallback: registrations and the backfill must establish it before
// any player-facing surface can resolve an account.
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
  username: UsernameSchema.nullable(),
  emailVerified: z.boolean(),
  image: z.url().nullable().optional(),
  theme: ThemeSchema,
  language: LanguageSchema,
  phoneNumber: z.string().nullable().optional(),
  phoneVerified: z.boolean().optional(),
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
});

export const PHONE_LOGIN_ERROR_REASONS = [
  'otp_cancelled',
  'rg_blocked',
  'account_suspended',
] as const;
export const PhoneLoginErrorReasonSchema = z.enum(PHONE_LOGIN_ERROR_REASONS);

export const PHONE_LOGIN_OTP_INVALID_REASONS = ['expired', 'wrong_code'] as const;
export const PhoneLoginOtpInvalidReasonSchema = z.enum(PHONE_LOGIN_OTP_INVALID_REASONS);

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

const credentialsBase = z.object({
  email: z.email(),
  password: z.string().min(8),
});

export const LoginInputSchema = credentialsBase.extend({
  rememberMe: z.boolean().optional(),
});

export const RegisterInputSchema = credentialsBase.extend({
  username: UsernameSchema,
  acceptedTerms: z.literal(true),
  acceptedAge: z.literal(true),
});

export const RegisterOutputSchema = z.object({ status: z.literal('check-email') });

export const UsernameAvailabilityInputSchema = z.object({ username: UsernameSchema });

export const UsernameAvailabilityOutputSchema = z.object({ available: z.boolean() });

export const Enable2faInputSchema = z.object({
  password: z.string().min(8),
});

export const Enable2faResultSchema = z.object({
  totpUri: z.string().min(1),
  backupCodes: z.array(z.string()),
});

export const Verify2faInputSchema = z.object({
  code: z.string().min(6).max(10),
});

export const Disable2faInputSchema = z.object({
  password: z.string().min(8),
});

export const RequestPasswordResetInputSchema = z.object({
  email: z.email(),
});

export const ResetPasswordInputSchema = z.object({
  email: z.email(),
  otp: z.string().length(OTP_CODE_LENGTH),
  token: z.string().min(1).optional(),
  // Upper-bounded to better-auth's own maxPasswordLength default (128): better-auth checks
  // this AFTER consuming the OTP, so an over-length password would burn a valid one-time
  // code and still get rejected - reject it here instead, before the OTP is ever spent.
  newPassword: z.string().min(8).max(128),
});

export const VerifyPasswordResetOtpInputSchema = ResetPasswordInputSchema.pick({
  email: true,
  otp: true,
});

export const VerifyEmailInputSchema = z.object({
  token: z.string().min(1),
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
  newPassword: z.string().min(8),
});

export const ChangeEmailInputSchema = z.object({
  newEmail: z.email(),
});

export const IdentitySuccessSchema = z.object({ success: z.literal(true) });

export type User = z.infer<typeof UserSchema>;
export type Organization = z.infer<typeof OrganizationSchema>;
export type Member = z.infer<typeof MemberSchema>;
export type LoginInput = z.infer<typeof LoginInputSchema>;
export type RegisterInput = z.infer<typeof RegisterInputSchema>;
export type RegisterOutput = z.infer<typeof RegisterOutputSchema>;
export type UsernameAvailabilityInput = z.infer<typeof UsernameAvailabilityInputSchema>;
export type UsernameAvailabilityOutput = z.infer<typeof UsernameAvailabilityOutputSchema>;
export type Enable2faInput = z.infer<typeof Enable2faInputSchema>;
export type Enable2faResult = z.infer<typeof Enable2faResultSchema>;
export type Verify2faInput = z.infer<typeof Verify2faInputSchema>;
export type Disable2faInput = z.infer<typeof Disable2faInputSchema>;
export type RequestPasswordResetInput = z.infer<typeof RequestPasswordResetInputSchema>;
export type ResetPasswordInput = z.infer<typeof ResetPasswordInputSchema>;
export type VerifyPasswordResetOtpInput = z.infer<typeof VerifyPasswordResetOtpInputSchema>;
export type VerifyEmailInput = z.infer<typeof VerifyEmailInputSchema>;
export type UpdateProfileInput = z.infer<typeof UpdateProfileInputSchema>;
export type ChangePasswordInput = z.infer<typeof ChangePasswordInputSchema>;
export type ChangeEmailInput = z.infer<typeof ChangeEmailInputSchema>;
export type E164Phone = z.infer<typeof E164PhoneSchema>;
export type PhoneLoginRequestInput = z.infer<typeof PhoneLoginRequestInputSchema>;
export type PhoneLoginRequestOutput = z.infer<typeof PhoneLoginRequestOutputSchema>;
export type PhoneLoginVerifyInput = z.infer<typeof PhoneLoginVerifyInputSchema>;
export type PhoneLoginErrorReason = z.infer<typeof PhoneLoginErrorReasonSchema>;
export type PhoneLoginOtpInvalidReason = z.infer<typeof PhoneLoginOtpInvalidReasonSchema>;

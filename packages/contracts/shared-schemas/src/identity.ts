import { z } from 'zod';
import { UuidSchema, TimestampSchema } from './common.js';

// id is a uuid: better-auth is configured with advanced.database.generateId to
// emit uuids (see @oss/auth), matching the platform-wide uuid id convention.
// image may be null in storage; the schema accepts string | null | absent.
export const UserSchema = z.object({
  id: UuidSchema,
  email: z.email(),
  name: z.string().min(1).max(255),
  emailVerified: z.boolean(),
  image: z.url().nullable().optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

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

export const LoginInputSchema = z.object({
  email: z.email(),
  password: z.string().min(8),
});

export const RegisterInputSchema = z.object({
  email: z.email(),
  password: z.string().min(8),
  name: z.string().min(1).max(255),
});

// --- Two-factor (TOTP), password reset, email verification, profile ---
// Inputs/outputs for the better-auth-backed identity routes. Password fields
// reuse the min(8) rule from LoginInputSchema.

export const Enable2faInputSchema = z.object({
  password: z.string().min(8),
});

export const Enable2faResultSchema = z.object({
  // otpauth:// URI to render as a QR code in an authenticator app.
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
  token: z.string().min(1),
  newPassword: z.string().min(8),
});

export const VerifyEmailInputSchema = z.object({
  token: z.string().min(1),
});

export const UpdateProfileInputSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    image: z.url().nullable().optional(),
  })
  .refine((v) => v.name !== undefined || v.image !== undefined, {
    message: 'Provide at least one field to update',
  });

export const ChangePasswordInputSchema = z.object({
  currentPassword: z.string().min(8),
  newPassword: z.string().min(8),
});

export const ChangeEmailInputSchema = z.object({
  newEmail: z.email(),
});

// Generic success envelope shared by the side-effecting identity routes.
export const IdentitySuccessSchema = z.object({ success: z.literal(true) });

export type User = z.infer<typeof UserSchema>;
export type Organization = z.infer<typeof OrganizationSchema>;
export type Member = z.infer<typeof MemberSchema>;
export type LoginInput = z.infer<typeof LoginInputSchema>;
export type RegisterInput = z.infer<typeof RegisterInputSchema>;
export type Enable2faInput = z.infer<typeof Enable2faInputSchema>;
export type Enable2faResult = z.infer<typeof Enable2faResultSchema>;
export type Verify2faInput = z.infer<typeof Verify2faInputSchema>;
export type Disable2faInput = z.infer<typeof Disable2faInputSchema>;
export type RequestPasswordResetInput = z.infer<typeof RequestPasswordResetInputSchema>;
export type ResetPasswordInput = z.infer<typeof ResetPasswordInputSchema>;
export type VerifyEmailInput = z.infer<typeof VerifyEmailInputSchema>;
export type UpdateProfileInput = z.infer<typeof UpdateProfileInputSchema>;
export type ChangePasswordInput = z.infer<typeof ChangePasswordInputSchema>;
export type ChangeEmailInput = z.infer<typeof ChangeEmailInputSchema>;

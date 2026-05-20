import { z } from 'zod';
import { UuidSchema, TimestampSchema } from './common.js';

// id is a plain string (better-auth uses random 32-char ids by default, not UUIDs).
// image may be null in storage; the schema accepts string | null | absent.
export const UserSchema = z.object({
  id: z.string().min(1),
  email: z.email(),
  name: z.string().min(1).max(255),
  emailVerified: z.boolean(),
  image: z.string().url().nullable().optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const OrganizationSchema = z.object({
  id: UuidSchema,
  name: z.string().min(1).max(255),
  slug: z.string().min(1).max(100),
  logo: z.string().url().optional(),
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

export type User = z.infer<typeof UserSchema>;
export type Organization = z.infer<typeof OrganizationSchema>;
export type Member = z.infer<typeof MemberSchema>;
export type LoginInput = z.infer<typeof LoginInputSchema>;
export type RegisterInput = z.infer<typeof RegisterInputSchema>;
